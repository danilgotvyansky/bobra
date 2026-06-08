import {
  sqliteTable,
  text,
  integer,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  varchar,
  uuid,
  boolean as pgBoolean,
  timestamp,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tokens = pgTable('tokens', {
  uid: uuid('uid').primaryKey(),
  name: varchar('name', { length: 255 }),
  tokenHash: varchar('token_hash', { length: 128 }).notNull(),
  tokenSalt: varchar('token_salt', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at'),
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
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
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
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`)
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
