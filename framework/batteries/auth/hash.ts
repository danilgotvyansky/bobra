import { getLogger } from '../../logging/logger';

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

// Find a token record by computing hash against all stored records
export async function findTokenByHash(
  db: any,
  token: string,
  schema: any,
  useSqlite?: boolean
) {
  try {
    const t = useSqlite ? schema.tokensSqlite : schema.tokens;
    const tokenRecords = await db.select({
      id: (t as any).uid,
      tokenHash: t.tokenHash,
      tokenSalt: t.tokenSalt,
      expiresAt: t.expiresAt,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      ipAddresses: t.ipAddresses,
      initToken: t.initToken
    }).from(t);

    for (const record of tokenRecords) {
      try {
        const computedHash = await hashToken(token, record.tokenSalt);
        if (computedHash === record.tokenHash) {
          // Normalize date fields across engines
          const normalizeDate = (d: any) => {
            if (!d) return undefined;
            if (d instanceof Date) return d;
            if (typeof d === 'number') return new Date(d);
            if (typeof d === 'string') return new Date(d);
            return undefined;
          };
          // Parse ipAddresses if stored as text (sqlite)
          const parseIps = (ips: any) => {
            if (!ips) return undefined;
            if (Array.isArray(ips)) return ips;
            if (typeof ips === 'string') {
              try { return JSON.parse(ips); } catch { return undefined; }
            }
            return undefined;
          };
          return {
            ...record,
            createdAt: normalizeDate(record.createdAt)!,
            expiresAt: normalizeDate(record.expiresAt)!,
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
