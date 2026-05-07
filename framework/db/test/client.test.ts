import { describe, expect, it, beforeAll } from 'vitest';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import {
  buildOrderedPostgresCandidates,
  type FailoverDirectClientAdapter,
  FailoverPgPool,
  type FailoverPoolAdapter,
  isTransientConnectionOrUnavailableError,
  resolvePgFailoverOptions,
  type AppEnvBindings,
  type PgFailoverOptions,
  type PostgresCandidate,
} from '../client';
import { initializeLogger, LogLevel } from '../../logging/logger';

beforeAll(() => {
  initializeLogger({
    level: LogLevel.SILENT,
    colorize: false,
    includeContext: false,
    includeTimestamp: false,
    format: 'text',
  });
});

function createQueryResult<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  } as QueryResult<R>;
}

function createMockPoolAdapter(
  connectImpl: () => Promise<PoolClient>,
): FailoverPoolAdapter {
  return {
    query: async () => createQueryResult([]),
    connect: connectImpl,
    end: async () => undefined,
    on: () => undefined,
  };
}

function createMockPoolClient(
  queryImpl: (...args: unknown[]) => Promise<QueryResult<QueryResultRow>>,
): PoolClient {
  return {
    query: (...args: unknown[]) => queryImpl(...args),
    release: () => undefined,
  } as PoolClient;
}

function createMockDirectClient(
  queryImpl: (...args: unknown[]) => Promise<QueryResult<QueryResultRow>>,
  connectImpl: () => Promise<void> = async () => undefined,
): FailoverDirectClientAdapter {
  return {
    connect: connectImpl,
    query: (...args: unknown[]) => queryImpl(...args),
    end: async () => undefined,
    release: () => undefined,
  };
}

describe('db/client failover', () => {
  it('identifies nested transient network errors', () => {
    const err = {
      code: '58000',
      message: 'Failed to acquire a connection from the pool.',
      cause: {
        code: 'ECONNRESET',
        message: 'socket hang up',
      },
    };

    expect(isTransientConnectionOrUnavailableError(err)).toBe(true);
    expect(isTransientConnectionOrUnavailableError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(
      isTransientConnectionOrUnavailableError(
        new Error('Connecting to database via Cloudflare Tunnel failed: 502 Bad Gateway')
      )
    ).toBe(true);
    expect(isTransientConnectionOrUnavailableError({ code: '23505', message: 'duplicate key' })).toBe(false);
  });

  it('keeps router-preferred location first in candidate ordering', () => {
    const env: AppEnvBindings = {
      POSTGRES_EU: { connectionString: 'postgres://eu' },
      POSTGRES_US: { connectionString: 'postgres://us' },
      POSTGRES: { connectionString: 'postgres://fallback' },
    };

    const { candidates, orderedLocations } = buildOrderedPostgresCandidates(
      env,
      undefined,
      ['eu', 'us'],
      () => 'us',
      'NA',
      { continent: 'NA' },
    );

    expect(orderedLocations).toEqual(['us', 'eu']);
    expect(candidates[0]?.bindingName).toBe('POSTGRES_US');
    expect(candidates[1]?.bindingName).toBe('POSTGRES_EU');
    expect(candidates[2]?.bindingName).toBe('POSTGRES');
  });

  it('disables failover when PGEDGE_FAILOVER_ENABLED is false', () => {
    expect(resolvePgFailoverOptions({
      PGEDGE_FAILOVER_ENABLED: 'false',
    }, 2)).toEqual({
      enabled: false,
      connectionTimeoutMs: 2000,
      warnLogging: true,
    });
  });

  it('falls back on transient query errors', async () => {
    const calls: string[] = [];
    const options: PgFailoverOptions = {
      enabled: true,
      connectionTimeoutMs: 2000,
      warnLogging: false,
    };

    const candidates: PostgresCandidate[] = [
      { bindingName: 'POSTGRES_EU', binding: { connectionString: 'postgres://eu' }, location: 'eu' },
      { bindingName: 'POSTGRES_US', binding: { connectionString: 'postgres://us' }, location: 'us' },
    ];

    const pool = new FailoverPgPool(
      candidates,
      options,
      () => createMockPoolAdapter(async () => {
        throw new Error('pool connect should not be used before the candidate is proven healthy');
      }),
      (candidate) => {
        if (candidate.bindingName === 'POSTGRES_EU') {
          return createMockDirectClient(async () => {
            calls.push('eu-query');
            const error = new Error('connection reset');
            (error as Error & { code?: string }).code = 'ECONNRESET';
            throw error;
          }, async () => {
            calls.push('eu-connect');
          });
        }

        return createMockDirectClient(async () => {
          calls.push('us-query');
          return createQueryResult([{ ok: 1 }]);
        }, async () => {
          calls.push('us-connect');
        });
      },
    );

    const result = await pool.query('select 1');
    expect(result.rows).toHaveLength(1);
    expect(calls).toEqual(['eu-connect', 'eu-query', 'us-connect', 'us-query']);
  });

  it('falls back on pg connection termination errors without an error code', async () => {
    const calls: string[] = [];
    const options: PgFailoverOptions = {
      enabled: true,
      connectionTimeoutMs: 2000,
      warnLogging: false,
    };

    const candidates: PostgresCandidate[] = [
      { bindingName: 'POSTGRES_US', binding: { connectionString: 'postgres://us' }, location: 'us' },
      { bindingName: 'POSTGRES_EU', binding: { connectionString: 'postgres://eu' }, location: 'eu' },
    ];

    const pool = new FailoverPgPool(
      candidates,
      options,
      () => createMockPoolAdapter(async () => {
        throw new Error('pool connect should not be used before the candidate is proven healthy');
      }),
      (candidate) => {
        if (candidate.bindingName === 'POSTGRES_US') {
          return createMockDirectClient(async () => {
            calls.push('us-query');
            throw new Error('Connection terminated unexpectedly');
          }, async () => {
            calls.push('us-connect');
          });
        }

        return createMockDirectClient(async () => {
          calls.push('eu-query');
          return createQueryResult([{ ok: 1 }]);
        }, async () => {
          calls.push('eu-connect');
        });
      },
    );

    const result = await pool.query('select 1');
    expect(result.rows).toHaveLength(1);
    expect(calls).toEqual(['us-connect', 'us-query', 'eu-connect', 'eu-query']);
  });

  it('does not fallback on non-transient connect errors', async () => {
    const calls: string[] = [];
    const options: PgFailoverOptions = {
      enabled: true,
      connectionTimeoutMs: 2000,
      warnLogging: false,
    };

    const candidates: PostgresCandidate[] = [
      { bindingName: 'POSTGRES_EU', binding: { connectionString: 'postgres://eu' }, location: 'eu' },
      { bindingName: 'POSTGRES_US', binding: { connectionString: 'postgres://us' }, location: 'us' },
    ];

    const pool = new FailoverPgPool(
      candidates,
      options,
      () => createMockPoolAdapter(async () => {
        throw new Error('pool connect should not be used before the candidate is proven healthy');
      }),
      (candidate) => {
        if (candidate.bindingName === 'POSTGRES_EU') {
          return createMockDirectClient(
            async () => createQueryResult([{ ok: 1 }]),
            async () => {
              calls.push('eu-connect');
              const error = new Error('duplicate key');
              (error as Error & { code?: string }).code = '23505';
              throw error;
            },
          );
        }

        return createMockDirectClient(
          async () => createQueryResult([{ ok: 1 }]),
          async () => {
            calls.push('us-connect');
          },
        );
      },
    );

    await expect(pool.connect()).rejects.toMatchObject({ code: '23505' });
    expect(calls).toEqual(['eu-connect']);
  });

  it('falls back when reading the primary connection string throws', async () => {
    const calls: string[] = [];
    const options: PgFailoverOptions = {
      enabled: true,
      connectionTimeoutMs: 2000,
      warnLogging: false,
    };

    const failingBinding = Object.create(null) as { connectionString: string };
    Object.defineProperty(failingBinding, 'connectionString', {
      get() {
        const error = new Error('connection refused during binding access');
        (error as Error & { code?: string }).code = 'ECONNREFUSED';
        throw error;
      },
    });

    const candidates: PostgresCandidate[] = [
      { bindingName: 'POSTGRES_EU', binding: failingBinding, location: 'eu' },
      { bindingName: 'POSTGRES_US', binding: { connectionString: 'postgres://us' }, location: 'us' },
    ];

    const pool = new FailoverPgPool(
      candidates,
      options,
      () => createMockPoolAdapter(async () => {
        throw new Error('pool connect should not be used before the candidate is proven healthy');
      }),
      (candidate) => {
        calls.push(candidate.bindingName);
        void candidate.binding.connectionString;
        return createMockDirectClient(
          async () => createQueryResult([{ ok: 1 }]),
          async () => {
            calls.push(`${candidate.bindingName}-connect`);
          },
        );
      },
    );

    const result = await pool.query('select 1');
    expect(result.rows).toHaveLength(1);
    expect(calls).toEqual(['POSTGRES_EU', 'POSTGRES_US', 'POSTGRES_US-connect']);
  });

  it('is a Pool instance so Drizzle transactions pin a single client', () => {
    const pool = new FailoverPgPool([], {
      enabled: true,
      connectionTimeoutMs: 2000,
      warnLogging: false,
    });

    expect(pool).toBeInstanceOf(Pool);
  });

  it('switches to pooled connections after a candidate proves healthy', async () => {
    const calls: string[] = [];
    const options: PgFailoverOptions = {
      enabled: true,
      connectionTimeoutMs: 2000,
      warnLogging: false,
    };

    const candidates: PostgresCandidate[] = [
      { bindingName: 'POSTGRES_US', binding: { connectionString: 'postgres://us' }, location: 'us' },
    ];

    const pool = new FailoverPgPool(
      candidates,
      options,
      () => createMockPoolAdapter(async () => {
        calls.push('pool-connect');
        return createMockPoolClient(async () => {
          calls.push('pool-query');
          return createQueryResult([{ ok: 2 }]);
        });
      }),
      () => createMockDirectClient(async () => {
        calls.push('direct-query');
        return createQueryResult([{ ok: 1 }]);
      }, async () => {
        calls.push('direct-connect');
      }),
    );

    const firstResult = await pool.query('select 1');
    const secondResult = await pool.query('select 2');

    expect(firstResult.rows).toEqual([{ ok: 1 }]);
    expect(secondResult.rows).toEqual([{ ok: 2 }]);
    expect(calls).toEqual(['direct-connect', 'direct-query', 'pool-connect', 'pool-query']);
  });
});
