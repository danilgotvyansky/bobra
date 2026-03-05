import {
  sqliteTable,
  text,
  integer,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  varchar,
  boolean as pgBoolean,
  timestamp,
  jsonb,
  index as pgIndex,
} from 'drizzle-orm/pg-core';

export const tokens = pgTable('tokens', {
  uid: varchar('uid', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }),
  tokenHash: varchar('token_hash', { length: 128 }).notNull(),
  tokenSalt: varchar('token_salt', { length: 64 }).notNull(),
  ipAddresses: jsonb('ip_addresses'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
  initToken: pgBoolean('init_token').notNull().default(false)
}, (table) => ({
  idx_tokens_init: pgIndex('idx_tokens_init').on(table.initToken)
}));

export const tokensSqlite = sqliteTable('tokens', {
  uid: text('uid').primaryKey(),
  name: text('name'),
  tokenHash: text('token_hash').notNull(),
  tokenSalt: text('token_salt').notNull(),
  ipAddresses: text('ip_addresses').$type<string | null>(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at').$type<string | null>(),
  initToken: integer('init_token').notNull().default(0)
});

export const initTokenCreated = pgTable('init_token_created', {
  id: varchar('id', { length: 16 }).primaryKey(),
  created: pgBoolean('created').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow()
});

export const initTokenCreatedSqlite = sqliteTable('init_token_created', {
  id: text('id').primaryKey(),
  created: integer('created').notNull().default(0),
  createdAt: text('created_at').notNull()
});

export type Tokens = typeof tokens.$inferSelect | typeof tokensSqlite.$inferSelect;
export type NewToken = typeof tokens.$inferInsert | typeof tokensSqlite.$inferInsert;

// Token schema object for passing to getDb/getDatabaseContext
export const tokenSchema = {
  tokens,
  tokensSqlite,
  initTokenCreated,
  initTokenCreatedSqlite,
} as const;
