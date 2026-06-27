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

const TRANSIENT_CONNECTION_MESSAGE_PATTERNS = [
  'connection terminated unexpectedly',
  'connection ended unexpectedly',
  'server closed the connection unexpectedly',
  'client has encountered a connection error and is not queryable',
  'timeout exceeded when trying to connect',
  'connection timeout',
  'failed to acquire a connection from the pool',
  'server connection attempt failed',
  'connecting to database via cloudflare tunnel failed',
  '502 bad gateway',
];

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

    const errorMessage = readErrorMessage(currentError).toLowerCase();
    if (TRANSIENT_CONNECTION_MESSAGE_PATTERNS.some((pattern) => errorMessage.includes(pattern))) {
      return true;
    }

    const errorCode = readErrorCode(currentError);
    if (errorCode) {
      if (TRANSIENT_NODE_ERROR_CODES.has(errorCode)) return true;
      if (errorCode.startsWith('UND_ERR_')) return true;
      if (errorCode.startsWith('08')) return true;
      if (TRANSIENT_PG_SQLSTATE_CODES.has(errorCode)) return true;
      if (errorCode === '58000') {
        const isHyperdriveTransient = errorMessage.includes('pool acquisition')
          || errorMessage.includes('failed to acquire a connection from the pool')
          || errorMessage.includes('server connection attempt failed');
        if (isHyperdriveTransient) return true;
      }
    }

    currentError = (currentError as ErrorWithCode).cause;
  }

  return false;
}

type PoolEventName = Parameters<Pool['on']>[0];
type PoolListener = Parameters<Pool['on']>[1];
type QueryArgs = Parameters<PoolClient['query']>;

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

function isBeginQuery(args: QueryArgs): boolean {
  const firstArg = args[0];
  if (typeof firstArg === 'string') {
    return firstArg.trim().toLowerCase() === 'begin';
  }

  if (firstArg && typeof firstArg === 'object') {
    const text = (firstArg as { text?: unknown }).text;
    return typeof text === 'string' && text.trim().toLowerCase() === 'begin';
  }

  return false;
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

  private wrapTransactionStartFailoverClient(
    initialClient: PoolClient,
    initialCandidateIndex: number
  ): PoolClient {
    const logger = getLogger();
    let activeClient = initialClient;
    let activeCandidateIndex = initialCandidateIndex;
    let activeClientReleased = false;
    let transactionStarted = false;
    let released = false;

    const releaseActiveClient = (err?: Error | boolean): void => {
      if (activeClientReleased) return;
      activeClient.release(err);
      activeClientReleased = true;
    };

    const queryWithBeginFailover = async <R extends QueryResultRow = QueryResultRow>(
      ...args: QueryArgs
    ): Promise<QueryResult<R>> => {
      if (transactionStarted || !isBeginQuery(args)) {
        const queryFn = activeClient.query.bind(activeClient) as (...queryArgs: QueryArgs) => Promise<QueryResult<R>>;
        return await queryFn(...args);
      }

      let lastError: Error | undefined;
      for (let index = activeCandidateIndex; index < this.candidates.length; index += 1) {
        const candidate = this.candidates[index]!;

        if (index !== activeCandidateIndex || activeClientReleased) {
          try {
            activeClient = await this.connectCandidate(candidate);
            activeCandidateIndex = index;
            activeClientReleased = false;
          } catch (connectError) {
            lastError = toError(connectError);
            this.invalidateCandidate(candidate);
            const hasNextCandidate = index < this.candidates.length - 1;
            const shouldFallback = hasNextCandidate && isTransientConnectionOrUnavailableError(connectError);

            if (!shouldFallback) {
              break;
            }

            if (this.failoverOptions.warnLogging) {
              const nextCandidate = this.candidates[index + 1]!;
              logger.warn('[getDb] Falling back to another PostgreSQL candidate after transient transaction reconnect error', {
                operation: 'transaction_reconnect',
                failedBinding: candidate.bindingName,
                failedLocation: candidate.location || null,
                fallbackBinding: nextCandidate.bindingName,
                fallbackLocation: nextCandidate.location || null,
                locationChanged: (candidate.location || null) !== (nextCandidate.location || null),
                errorCode: readErrorCode(connectError) || null,
                message: readErrorMessage(connectError),
              });
            }

            continue;
          }
        }

        try {
          const queryFn = activeClient.query.bind(activeClient) as (...queryArgs: QueryArgs) => Promise<QueryResult<R>>;
          const result = await queryFn(...args);
          transactionStarted = true;
          activeCandidateIndex = index;
          return result;
        } catch (error) {
          lastError = toError(error);
          this.invalidateCandidate(candidate);
          releaseActiveClient();

          const hasNextCandidate = index < this.candidates.length - 1;
          const shouldFallback = hasNextCandidate && isTransientConnectionOrUnavailableError(error);
          if (!shouldFallback) {
            break;
          }

          const nextCandidate = this.candidates[index + 1]!;
          if (this.failoverOptions.warnLogging) {
            logger.warn('[getDb] Falling back to another PostgreSQL candidate after transient transaction begin error', {
              operation: 'transaction_begin',
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

      const errorToThrow = lastError ?? new Error('Postgres transaction begin failed without an error payload');
      logger.error('[getDb] PostgreSQL failover exhausted for transaction begin', errorToThrow, {
        candidates: this.candidates.map(formatCandidateLabel),
        transientClassified: isTransientConnectionOrUnavailableError(errorToThrow),
      });
      throw errorToThrow;
    };

    const releaseWrappedClient = ((err?: Error | boolean) => {
      if (released) return;
      released = true;
      releaseActiveClient(err);
    }) as PoolClient['release'];

    return new Proxy(initialClient, {
      get(_target: PoolClient, property: string | symbol): unknown {
        if (property === 'query') {
          return queryWithBeginFailover as PoolClient['query'];
        }

        if (property === 'release') {
          return releaseWrappedClient;
        }

        const value = Reflect.get(activeClient as object, property);
        if (typeof value === 'function') {
          return value.bind(activeClient);
        }

        return value;
      },
      set(_target: PoolClient, property: string | symbol, value: unknown): boolean {
        return Reflect.set(activeClient as object, property, value);
      },
    }) as PoolClient;
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
        const client = await this.connectCandidate(candidate);
        return this.wrapTransactionStartFailoverClient(client, index);
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
