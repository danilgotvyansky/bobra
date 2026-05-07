import {
  DrizzleD1Client,
  DrizzlePgClient,
  getDatabaseContext,
  getDb,
  isSQLite,
  type AppEnvBindings
} from '@danylohotvianskyi/bobra-framework/db';
import { eq } from 'drizzle-orm';
import { schema } from '@example-app/shared-utils/src/db';
import type { APIToken } from './schemas';

type PgTokenInsert = typeof schema.tokens.$inferInsert;
type SqliteTokenInsert = typeof schema.tokensSqlite.$inferInsert;

function normalizeTimestamp(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' ? value : null;
  }

  return date.toISOString();
}

export async function insertToken(env: AppEnvBindings, record: APIToken) {
  const ctx = getDatabaseContext(env, schema);
  if (isSQLite(ctx)) {
    const db = getDb(env, schema) as DrizzleD1Client;
    const values: SqliteTokenInsert = {
      uid: record.uid,
      name: record.name || null,
      tokenHash: record.tokenHash,
      tokenSalt: record.tokenSalt,
      initToken: record.initToken ? 1 : 0,
      ...(record.createdAt ? { createdAt: new Date(record.createdAt).toISOString() } : {}),
      ...(record.lastUsedAt ? { lastUsedAt: new Date(record.lastUsedAt).toISOString() } : {}),
      ...(record.expiresAt ? { expiresAt: new Date(record.expiresAt).toISOString() } : {}),
    };
    return await db.insert(schema.tokensSqlite).values(values);
  }

  const db = getDb(env, schema) as DrizzlePgClient;
  const values: PgTokenInsert = {
    uid: record.uid,
    name: record.name || null,
    tokenHash: record.tokenHash,
    tokenSalt: record.tokenSalt,
    initToken: Boolean(record.initToken),
    ...(record.createdAt ? { createdAt: new Date(record.createdAt) } : {}),
    ...(record.lastUsedAt ? { lastUsedAt: new Date(record.lastUsedAt) } : {}),
    ...(record.expiresAt ? { expiresAt: new Date(record.expiresAt) } : {}),
  };
  return await db.insert(schema.tokens).values(values);
}

export async function getToken(env: AppEnvBindings, uid: string) {
  const ctx = getDatabaseContext(env, schema);
  const [token] = isSQLite(ctx)
    ? await (getDb(env, schema) as DrizzleD1Client)
      .select({
        uid: schema.tokensSqlite.uid,
        name: schema.tokensSqlite.name,
        createdAt: schema.tokensSqlite.createdAt,
        lastUsedAt: schema.tokensSqlite.lastUsedAt,
        expiresAt: schema.tokensSqlite.expiresAt,
      })
      .from(schema.tokensSqlite)
      .where(eq(schema.tokensSqlite.uid, uid))
    : await (getDb(env, schema) as DrizzlePgClient)
      .select({
        uid: schema.tokens.uid,
        name: schema.tokens.name,
        createdAt: schema.tokens.createdAt,
        lastUsedAt: schema.tokens.lastUsedAt,
        expiresAt: schema.tokens.expiresAt,
      })
      .from(schema.tokens)
      .where(eq(schema.tokens.uid, uid));

  if (!token) throw new Error('Token not found');

  const createdAt = normalizeTimestamp(token.createdAt);
  const expiresAt = normalizeTimestamp(token.expiresAt);
  if (!createdAt || !expiresAt) {
    throw new Error('Invalid token timestamp format');
  }

  return {
    ...token,
    createdAt,
    expiresAt,
    lastUsedAt: normalizeTimestamp(token.lastUsedAt),
  };
}

export async function deleteToken(env: AppEnvBindings, tokenUid: string) {
  const ctx = getDatabaseContext(env, schema);
  if (isSQLite(ctx)) {
    const db = getDb(env, schema) as DrizzleD1Client;
    const tokenExists = await db.select({ uid: schema.tokensSqlite.uid })
      .from(schema.tokensSqlite)
      .where(eq(schema.tokensSqlite.uid, tokenUid))
      .limit(1);
    if (tokenExists.length === 0) {
      return { found: false };
    }
    await db.delete(schema.tokensSqlite)
      .where(eq(schema.tokensSqlite.uid, tokenUid));
    return { found: true };
  }

  const db = getDb(env, schema) as DrizzlePgClient;
  const tokenExists = await db.select({ uid: schema.tokens.uid })
    .from(schema.tokens)
    .where(eq(schema.tokens.uid, tokenUid))
    .limit(1);
  if (tokenExists.length === 0) {
    return { found: false };
  }
  await db.delete(schema.tokens)
    .where(eq(schema.tokens.uid, tokenUid));
  return { found: true };
}

export async function listTokens(env: AppEnvBindings) {
  const ctx = getDatabaseContext(env, schema);
  if (isSQLite(ctx)) {
    const db = getDb(env, schema) as DrizzleD1Client;
    const tokens = await db.select({
      uid: schema.tokensSqlite.uid,
      name: schema.tokensSqlite.name,
      createdAt: schema.tokensSqlite.createdAt,
      lastUsedAt: schema.tokensSqlite.lastUsedAt,
      expiresAt: schema.tokensSqlite.expiresAt,
      initToken: schema.tokensSqlite.initToken,
    }).from(schema.tokensSqlite);

    return tokens.map((token) => ({
      ...token,
      createdAt: normalizeTimestamp(token.createdAt),
      lastUsedAt: normalizeTimestamp(token.lastUsedAt),
      expiresAt: normalizeTimestamp(token.expiresAt),
    }));
  }

  const db = getDb(env, schema) as DrizzlePgClient;
  const tokens = await db.select({
    uid: schema.tokens.uid,
    name: schema.tokens.name,
    createdAt: schema.tokens.createdAt,
    lastUsedAt: schema.tokens.lastUsedAt,
    expiresAt: schema.tokens.expiresAt,
    initToken: schema.tokens.initToken,
  }).from(schema.tokens);

  return tokens.map((token) => ({
    ...token,
    createdAt: normalizeTimestamp(token.createdAt),
    lastUsedAt: normalizeTimestamp(token.lastUsedAt),
    expiresAt: normalizeTimestamp(token.expiresAt),
  }));
}
