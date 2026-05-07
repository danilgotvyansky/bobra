import { Client, Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { getLogger } from '../logging/logger';
import { formatCandidateLabel, readCandidateConnectionString } from './pgedge';
import type { PgFailoverOptions, PostgresCandidate } from './types';

type ErrorWithCode = Error & {
  code?: unknown;
  cause?: unknown;
};

const TRANSIENT_NODE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const TRANSIENT_PG_SQLSTATE_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
]);

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export function isTransientConnectionOrUnavailableError(error: unknown): boolean {
  let currentError: unknown = error;
  const visited = new Set<unknown>();

  while (currentError && typeof currentError === 'object' && !visited.has(currentError)) {
    visited.add(currentError);

    const errorCode = readErrorCode(currentError);
    if (errorCode) {
      if (TRANSIENT_NODE_ERROR_CODES.has(errorCode)) return true;
      if (errorCode.startsWith('UND_ERR_')) return true;
      if (errorCode.startsWith('08')) return true;
      if (TRANSIENT_PG_SQLSTATE_CODES.has(errorCode)) return true;
      if (errorCode === '58000') {
        const message = readErrorMessage(currentError).toLowerCase();
        const isHyperdriveTransient = message.includes('pool acquisition')
          || message.includes('server connection attempt failed');
        if (isHyperdriveTransient) return true;
      }
    }

    currentError = (currentError as ErrorWithCode).cause;
  }

  return false;
}

type PoolEventName = Parameters<Pool['on']>[0];
type PoolListener = Parameters<Pool['on']>[1];

export interface FailoverPoolAdapter {
  query: (...args: unknown[]) => Promise<QueryResult<QueryResultRow>>;
  connect: () => Promise<PoolClient>;
  end: () => Promise<void>;
  on: (event: PoolEventName, listener: PoolListener) => unknown;
}

export interface FailoverDirectClientAdapter {
  connect: () => Promise<void>;
  query: (...args: unknown[]) => Promise<QueryResult<QueryResultRow>>;
  end: () => Promise<void>;
  release: () => void;
}

export function attachPoolErrorLogger(pool: FailoverPoolAdapter, context: Record<string, unknown>): void {
  pool.on('error', (error: Error) => {
    getLogger().warn('[getDb] PostgreSQL pool emitted background error', {
      ...context,
      errorCode: readErrorCode(error) || null,
      message: readErrorMessage(error),
    });
  });
}

export class FailoverPgPool extends Pool {
  private readonly pools = new Map<string, FailoverPoolAdapter>();
  private readonly registeredListeners: Array<{ event: PoolEventName; listener: PoolListener }> = [];
  private readonly healthyCandidateBindings = new Set<string>();

  constructor(
    private readonly candidates: PostgresCandidate[],
    private readonly failoverOptions: PgFailoverOptions,
    private readonly poolFactory: (candidate: PostgresCandidate, options: PgFailoverOptions) => FailoverPoolAdapter = (
      candidate,
      options
    ) => new Pool({
      connectionString: readCandidateConnectionString(candidate),
      connectionTimeoutMillis: options.connectionTimeoutMs,
    }),
    private readonly directClientFactory: (
      candidate: PostgresCandidate,
      options: PgFailoverOptions
    ) => FailoverDirectClientAdapter = (candidate, options) => {
      const client = new Client({
        connectionString: readCandidateConnectionString(candidate),
        connectionTimeoutMillis: options.connectionTimeoutMs,
      });

      return {
        connect: async () => {
          await client.connect();
        },
        query: (...args: unknown[]) => {
          const queryFn = client.query.bind(client) as (...queryArgs: unknown[]) => Promise<QueryResult<QueryResultRow>>;
          return queryFn(...args);
        },
        end: () => client.end(),
        release: () => {
          void client.end().catch((error) => {
            getLogger().warn('[getDb] Failed to close direct PostgreSQL failover client', {
              binding: candidate.bindingName,
              location: candidate.location || null,
              errorCode: readErrorCode(error) || null,
              message: readErrorMessage(error),
            });
          });
        },
      };
    }
  ) {
    super();
  }

  private getPool(candidate: PostgresCandidate): FailoverPoolAdapter {
    const existingPool = this.pools.get(candidate.bindingName);
    if (existingPool) return existingPool;

    const pool = this.poolFactory(candidate, this.failoverOptions);
    attachPoolErrorLogger(pool, {
      binding: candidate.bindingName,
      location: candidate.location || null,
      operation: 'pool',
    });

    for (const { event, listener } of this.registeredListeners) {
      pool.on(event, listener);
    }

    this.pools.set(candidate.bindingName, pool);
    return pool;
  }

  on(event: PoolEventName, listener: PoolListener): this {
    super.on(event, listener);
    this.registeredListeners.push({ event, listener });
    for (const pool of this.pools.values()) {
      pool.on(event, listener);
    }
    return this;
  }

  private invalidateCandidate(candidate: PostgresCandidate): void {
    this.healthyCandidateBindings.delete(candidate.bindingName);

    const pool = this.pools.get(candidate.bindingName);
    if (!pool) return;

    this.pools.delete(candidate.bindingName);
    void pool.end().catch(() => undefined);
  }

  private async connectCandidate(candidate: PostgresCandidate): Promise<PoolClient> {
    if (this.healthyCandidateBindings.has(candidate.bindingName)) {
      const pool = this.getPool(candidate);
      return await pool.connect();
    }

    const directClient = this.directClientFactory(candidate, this.failoverOptions);
    await directClient.connect();
    this.healthyCandidateBindings.add(candidate.bindingName);

    return directClient as unknown as PoolClient;
  }

  async query<R extends QueryResultRow = QueryResultRow>(...args: unknown[]): Promise<QueryResult<R>> {
    const logger = getLogger();
    let lastError: Error | undefined;
    const attemptedBindings: string[] = [];

    for (let index = 0; index < this.candidates.length; index += 1) {
      const candidate = this.candidates[index]!;
      attemptedBindings.push(candidate.bindingName);
      let client: PoolClient | undefined;

      try {
        client = await this.connectCandidate(candidate);
        const queryFn = client.query.bind(client) as (...queryArgs: unknown[]) => Promise<QueryResult<R>>;
        return await queryFn(...args);
      } catch (error) {
        lastError = toError(error);
        this.invalidateCandidate(candidate);
        const hasNextCandidate = index < this.candidates.length - 1;
        const shouldFallback = hasNextCandidate && isTransientConnectionOrUnavailableError(error);

        if (!shouldFallback) {
          break;
        }

        if (this.failoverOptions.warnLogging) {
          const nextCandidate = this.candidates[index + 1]!;
          logger.warn('[getDb] Falling back to another PostgreSQL candidate after transient query error', {
            operation: client ? 'query' : 'connect',
            failedBinding: candidate.bindingName,
            failedLocation: candidate.location || null,
            fallbackBinding: nextCandidate.bindingName,
            fallbackLocation: nextCandidate.location || null,
            locationChanged: (candidate.location || null) !== (nextCandidate.location || null),
            errorCode: readErrorCode(error) || null,
            message: readErrorMessage(error),
          });
        }
      } finally {
        client?.release();
      }
    }

    const errorToThrow = lastError ?? new Error('Postgres query failed without an error payload');
    logger.error('[getDb] PostgreSQL failover exhausted for query', errorToThrow, {
      attemptedBindings,
      candidates: this.candidates.map(formatCandidateLabel),
      transientClassified: isTransientConnectionOrUnavailableError(errorToThrow),
    });
    throw errorToThrow;
  }

  async connect(): Promise<PoolClient> {
    const logger = getLogger();
    let lastError: Error | undefined;
    const attemptedBindings: string[] = [];

    for (let index = 0; index < this.candidates.length; index += 1) {
      const candidate = this.candidates[index]!;
      attemptedBindings.push(candidate.bindingName);
      try {
        return await this.connectCandidate(candidate);
      } catch (error) {
        lastError = toError(error);
        this.invalidateCandidate(candidate);
        const hasNextCandidate = index < this.candidates.length - 1;
        const shouldFallback = hasNextCandidate && isTransientConnectionOrUnavailableError(error);

        if (!shouldFallback) {
          break;
        }

        if (this.failoverOptions.warnLogging) {
          const nextCandidate = this.candidates[index + 1]!;
          logger.warn('[getDb] Falling back to another PostgreSQL candidate after transient connect error', {
            operation: 'connect',
            failedBinding: candidate.bindingName,
            failedLocation: candidate.location || null,
            fallbackBinding: nextCandidate.bindingName,
            fallbackLocation: nextCandidate.location || null,
            locationChanged: (candidate.location || null) !== (nextCandidate.location || null),
            errorCode: readErrorCode(error) || null,
            message: readErrorMessage(error),
          });
        }
      }
    }

    const errorToThrow = lastError ?? new Error('Postgres connect failed without an error payload');
    logger.error('[getDb] PostgreSQL failover exhausted for connect', errorToThrow, {
      attemptedBindings,
      candidates: this.candidates.map(formatCandidateLabel),
      transientClassified: isTransientConnectionOrUnavailableError(errorToThrow),
    });
    throw errorToThrow;
  }

  async end(): Promise<void> {
    const pools = [...this.pools.values()];
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
    await super.end().catch(() => undefined);
  }
}
