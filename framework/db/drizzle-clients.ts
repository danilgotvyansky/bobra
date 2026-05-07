import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { Pool } from 'pg';
import type { D1Database } from '@cloudflare/workers-types';
import { getLogger } from '../logging/logger';
import { attachPoolErrorLogger, FailoverPgPool } from './failover';
import { readCandidateConnectionString } from './pgedge';
import type {
  DrizzleD1Client,
  DrizzlePgClient,
  DrizzleSchema,
  PgFailoverOptions,
  PostgresCandidate,
} from './types';

export function createD1DrizzleClient<S extends DrizzleSchema>(d1: D1Database, schema: S): DrizzleD1Client<S> {
  return drizzleD1(d1, { schema });
}

export function createPgDrizzleClient<S extends DrizzleSchema>(
  connectionString: string,
  schema: S,
  connectionTimeoutMs?: number
): DrizzlePgClient<S> {
  try {
    const poolConfig: { connectionString: string; connectionTimeoutMillis?: number } = { connectionString };
    if (connectionTimeoutMs !== undefined) {
      poolConfig.connectionTimeoutMillis = connectionTimeoutMs;
    }
    const pool = new Pool(poolConfig);
    attachPoolErrorLogger(pool, {
      binding: 'POSTGRES',
      location: null,
      operation: 'pool',
    });
    return drizzlePg(pool, { schema });
  } catch (error) {
    getLogger().error('[createPgDrizzleClient] Error creating PostgreSQL client:', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export function createFailoverPgDrizzleClient<S extends DrizzleSchema>(
  candidates: PostgresCandidate[],
  schema: S,
  failoverOptions: PgFailoverOptions
): DrizzlePgClient<S> {
  try {
    const failoverPool = new FailoverPgPool(candidates, failoverOptions);
    return drizzlePg(failoverPool as unknown as Pool, { schema });
  } catch (error) {
    getLogger().error(
      '[createPgDrizzleClient] Error creating failover PostgreSQL client:',
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  }
}

export function createPrimaryPgDrizzleClient<S extends DrizzleSchema>(
  candidate: PostgresCandidate,
  schema: S
): DrizzlePgClient<S> {
  return createPgDrizzleClient(readCandidateConnectionString(candidate), schema);
}
