import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import type { AnyPgTable, AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AnySQLiteTable, AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { D1Database, Hyperdrive } from '@cloudflare/workers-types';

export interface AppEnvBindings {
  D1?: D1Database;
  POSTGRES?: { connectionString: string };
  DB_ENGINE?: string;
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  DEPLOYMENT_CONTEXT?: 'cloudflare' | 'self-hosted';
  PGEDGE_ENABLED?: boolean | string;
  PGEDGE_LOCATIONS?: string;
  PGEDGE_DEBUG_LOGGING?: boolean | string;
  PGEDGE_FAILOVER_ENABLED?: boolean | string;
  PGEDGE_FAILOVER_CONNECTION_TIMEOUT_MS?: number | string;
  PGEDGE_FAILOVER_WARN_LOGGING?: boolean | string;
  __cfContinent?: string;
  [key: string]: unknown;
}

export type DrizzleSchema = Record<string, unknown>;

export type DrizzleD1Client<S extends DrizzleSchema = DrizzleSchema> = ReturnType<typeof drizzleD1<S>>;
export type DrizzlePgClient<S extends DrizzleSchema = DrizzleSchema> = ReturnType<typeof drizzlePg<S>>;

export type TokenPgColumns = {
  uid: AnyPgColumn;
  tokenHash: AnyPgColumn;
  tokenSalt: AnyPgColumn;
  expiresAt: AnyPgColumn;
  createdAt: AnyPgColumn;
  lastUsedAt: AnyPgColumn;
  ipAddresses: AnyPgColumn;
  initToken: AnyPgColumn;
};

export type TokenSQLiteColumns = {
  uid: AnySQLiteColumn;
  tokenHash: AnySQLiteColumn;
  tokenSalt: AnySQLiteColumn;
  expiresAt: AnySQLiteColumn;
  createdAt: AnySQLiteColumn;
  lastUsedAt: AnySQLiteColumn;
  ipAddresses: AnySQLiteColumn;
  initToken: AnySQLiteColumn;
};

export type TokenTableColumns = TokenPgColumns | TokenSQLiteColumns;

export type TokenPgTable = AnyPgTable & TokenPgColumns;
export type TokenSQLiteTable = AnySQLiteTable & TokenSQLiteColumns;

export type TokenSchemaBindings = {
  tokens: TokenPgTable;
  tokensSqlite: TokenSQLiteTable;
};

export interface DatabaseContext<S extends DrizzleSchema = DrizzleSchema> {
  type: 'postgres' | 'd1-sqlite';
  db: DrizzleD1Client<S> | DrizzlePgClient<S>;
}

export interface CfInfo {
  continent?: string;
  colo?: string;
  [key: string]: unknown;
}

export type PgEdgeRouter = (locations: string[], cfContinentStr?: string, cfInfo?: unknown) => string;
export type PostgresBindingRole = string;

export interface DbContextOptions {
  cfInfo?: CfInfo;
  pgEdgeRouter?: PgEdgeRouter;
  postgresBindingRole?: PostgresBindingRole;
}

export interface PostgresBinding {
  connectionString: string;
}

export interface ResolvedPostgresBinding {
  bindingName: string;
  binding: PostgresBinding;
}

export interface PostgresCandidate extends ResolvedPostgresBinding {
  location?: string;
}

export interface PgFailoverOptions {
  enabled: boolean;
  connectionTimeoutMs: number;
  warnLogging: boolean;
}
