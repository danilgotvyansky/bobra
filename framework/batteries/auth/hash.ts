import { getLogger } from '../../logging/logger';
import {
  isSQLiteContext,
  isPostgresContext,
  type DatabaseContext,
  type DrizzleSchema,
  type TokenSchemaBindings,
  type TokenRecordInput,
  type TokenRecordRaw,
  type DateLike,
  type IpAddressesLike,
  tokenRecordRawSchema,
  ipAddressListSchema,
} from '../../db';
import * as v from 'valibot';

export function parseTokenRecord(input: TokenRecordInput): TokenRecordRaw | undefined {
  const parsed = v.safeParse(tokenRecordRawSchema, input);
  return parsed.success ? parsed.output : undefined;
}

export function parseIpAddressList(input: string[]): string[] | undefined {
  const parsed = v.safeParse(ipAddressListSchema, input);
  return parsed.success ? parsed.output : undefined;
}

// Token hash algorithm configuration
const HASH_CONFIG = {
  ALGORITHM: 'SHA-256'
} as const;

// Hash a token with a salt using SHA-256
export async function hashToken(token: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${token}${salt}`);

  const hashBuffer = await crypto.subtle.digest(HASH_CONFIG.ALGORITHM, data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export type MatchedTokenRecord = Omit<TokenRecordRaw, 'createdAt' | 'expiresAt' | 'lastUsedAt' | 'ipAddresses'> & {
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt?: Date;
  ipAddresses?: string[];
};

function normalizeDate(value: DateLike | null | undefined): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') return new Date(value);
  return undefined;
}

function parseIps(value: IpAddressesLike | undefined): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parseIpAddressList(parsed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Find a token record by computing hash against all stored records
export async function findTokenByHash(
  ctx: DatabaseContext<DrizzleSchema>,
  token: string,
  schema: TokenSchemaBindings,
): Promise<MatchedTokenRecord | null> {
  try {
    let tokenRecords: TokenRecordInput[];

    if (isSQLiteContext(ctx)) {
      tokenRecords = await ctx.db.select({
        uid: schema.tokensSqlite.uid,
        tokenHash: schema.tokensSqlite.tokenHash,
        tokenSalt: schema.tokensSqlite.tokenSalt,
        expiresAt: schema.tokensSqlite.expiresAt,
        createdAt: schema.tokensSqlite.createdAt,
        lastUsedAt: schema.tokensSqlite.lastUsedAt,
        initToken: schema.tokensSqlite.initToken
      }).from(schema.tokensSqlite) as TokenRecordInput[];
    } else if (isPostgresContext(ctx)) {
      tokenRecords = await ctx.db.select({
        uid: schema.tokens.uid,
        tokenHash: schema.tokens.tokenHash,
        tokenSalt: schema.tokens.tokenSalt,
        expiresAt: schema.tokens.expiresAt,
        createdAt: schema.tokens.createdAt,
        lastUsedAt: schema.tokens.lastUsedAt,
        initToken: schema.tokens.initToken
      }).from(schema.tokens) as TokenRecordInput[];
    } else {
      throw new Error('Unsupported database context type');
    }

    for (const rawRecord of tokenRecords) {
      try {
        const record = parseTokenRecord(rawRecord);
        if (!record) {
          continue;
        }

        if (typeof record.tokenSalt !== 'string' || typeof record.tokenHash !== 'string') {
          continue;
        }

        const computedHash = await hashToken(token, record.tokenSalt);
        if (computedHash === record.tokenHash) {
          const createdAt = normalizeDate(record.createdAt);
          const expiresAt = normalizeDate(record.expiresAt);

          if (!createdAt) {
            continue;
          }

          return {
            ...record,
            createdAt,
            expiresAt: expiresAt ?? null,
            lastUsedAt: normalizeDate(record.lastUsedAt),
            ipAddresses: parseIps(record.ipAddresses)
          };
        }
      } catch (hashError) {
        getLogger().error(`Token hash computation failed:`, hashError instanceof Error ? hashError : new Error(String(hashError)));
        continue;
      }
    }

    return null;
  } catch (error) {
    getLogger().error(`Error finding token by hash:`, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
