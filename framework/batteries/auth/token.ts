import { webcrypto } from 'crypto';
import { hashToken } from './hash';

export const TOKEN_CONSTANTS = {
  PREFIX: 'bct_',
  TOKEN_LENGTH: 48, // total length = 4 (prefix) + 48 = 52
  SALT_BYTES: 16,
  DEFAULT_EXPIRATION_DAYS: 90
} as const;

export function generateSecureToken(): string {
  const bytes = new Uint8Array(TOKEN_CONSTANTS.TOKEN_LENGTH);
  webcrypto.getRandomValues(bytes);
  const hexToken = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${TOKEN_CONSTANTS.PREFIX}${hexToken.slice(0, TOKEN_CONSTANTS.TOKEN_LENGTH)}`;
}

export function generateSalt(length: number = TOKEN_CONSTANTS.SALT_BYTES): string {
  const saltBytes = new Uint8Array(length);
  webcrypto.getRandomValues(saltBytes);
  return Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface PublicApiTokenOptions {
  name?: string;
  expiresAt?: number;
  ipAddresses?: string[];
  initToken?: boolean;
}

export async function createPublicApiToken(options: PublicApiTokenOptions): Promise<{
  token: string;
  record: {
    uid: string;
    name?: string;
    tokenHash: string;
    tokenSalt: string;
    ipAddresses?: string[];
    createdAt: number;
    lastUsedAt: number | null;
    expiresAt: number;
    initToken: boolean;
  };
}> {
  const now = Date.now();
  const defaultExpiresAt = now + (TOKEN_CONSTANTS.DEFAULT_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);
  const {
    name,
    expiresAt,
    ipAddresses = [],
    initToken = false
  } = options;

  const finalExpiresAt = expiresAt ?? defaultExpiresAt;

  const token = generateSecureToken();
  const tokenSalt = generateSalt();
  const tokenHash = await hashToken(token, tokenSalt);

  const record = {
    uid: webcrypto.randomUUID(),
    name,
    tokenHash,
    tokenSalt,
    ipAddresses,
    createdAt: now,
    lastUsedAt: null,
    expiresAt: finalExpiresAt,
    initToken
  };

  return { token, record };
}
