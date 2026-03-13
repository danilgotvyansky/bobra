import {
  convertBooleanForDb,
  getDatabaseContext,
  getDb,
  isSQLite,
  type AppEnvBindings
} from '@danylohotvianskyi/bobra-framework/db';
import { eq, and } from 'drizzle-orm';
import { schema } from '../../../shared-utils/src/db';
import type { APIToken } from './schemas';

export async function insertToken(env: AppEnvBindings, record: APIToken) {
  const db = getDb(env, schema) as any;
  const ctx = getDatabaseContext(env, schema);
  const target = isSQLite(ctx) ? schema.tokensSqlite : schema.tokens;
  const values: any = {
    uid: record.uid,
    name: record.name || null,
    tokenHash: record.tokenHash,
    tokenSalt: record.tokenSalt,
    ipAddresses: record.ipAddresses ? (isSQLite(ctx) ? JSON.stringify(record.ipAddresses) : record.ipAddresses) : null,
    initToken: record.initToken ? convertBooleanForDb(true, ctx) : convertBooleanForDb(false, ctx)
  };

  if (record.createdAt) {
    values.createdAt = isSQLite(ctx) ? new Date(record.createdAt).toISOString() : new Date(record.createdAt);
  }
  if (record.lastUsedAt) {
    values.lastUsedAt = isSQLite(ctx) ? new Date(record.lastUsedAt).toISOString() : new Date(record.lastUsedAt);
  }
  if (record.expiresAt) {
    values.expiresAt = isSQLite(ctx) ? new Date(record.expiresAt).toISOString() : new Date(record.expiresAt);
  }

  return await db.insert(target).values(values);
}

export async function getToken(env: AppEnvBindings, uid: string) {
  const db = getDb(env, schema) as any;
  const ctx = getDatabaseContext(env, schema);
  const target = isSQLite(ctx) ? schema.tokensSqlite : schema.tokens;
  const [token] = await db.select({
    uid: target.uid,
    name: target.name,
    ipAddresses: target.ipAddresses,
    createdAt: target.createdAt,
    lastUsedAt: target.lastUsedAt,
    expiresAt: target.expiresAt
  }).from(target).where(eq(target.uid, uid));

  if (!token) throw new Error('Token not found');

  return token;
}

export async function deleteToken(env: AppEnvBindings, tokenUid: string) {
  const db = getDb(env, schema) as any;
  const ctx = getDatabaseContext(env, schema);
  const target = isSQLite(ctx) ? schema.tokensSqlite : schema.tokens;
  const tokenExists = await db.select({ uid: target.uid })
    .from(target)
    .where(and(eq(target.uid, tokenUid)))
    .limit(1);
  if (tokenExists.length === 0) {
    return { found: false };
  }
  await db.delete(target)
    .where(eq(target.uid as any, tokenUid));
  return { found: true };
}

export async function listTokens(env: AppEnvBindings) {
  const db = getDb(env, schema) as any;
  const ctx = getDatabaseContext(env, schema);
  const target = isSQLite(ctx) ? schema.tokensSqlite : schema.tokens;
  const rows = await db.select({
    uid: target.uid,
    name: target.name,
    ipAddresses: target.ipAddresses,
    createdAt: target.createdAt,
    lastUsedAt: target.lastUsedAt,
    expiresAt: target.expiresAt,
    initToken: target.initToken
  })
    .from(target);
  return rows;
}
