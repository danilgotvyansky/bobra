import { TokenMetadataUpdateClient, updateTokenLastUsed } from './token-metadata';
import { hashToken, findTokenByHash } from './hash';

export interface TokenRecord {
  id: string;
  tokenHash: string;
  tokenSalt: string;
  expiresAt: Date;
  lastUsedAt?: Date;
  ipAddresses?: string[];
  initToken?: boolean | number;
}

export interface TokenValidationProvider extends TokenMetadataUpdateClient {
}

export interface TokenValidationResult {
  valid: boolean;
  reason?: string;
  tokenInfo?: {
    id: string;
    expiresAt: Date;
    lastUsedAt?: Date;
    ipAddresses?: string[];
    initToken?: boolean;
  };
}

// Validate a token against the database
export async function validateToken(
  token: string,
  provider: TokenValidationProvider
): Promise<TokenValidationResult> {
  try {
    const useSqlite = !!(provider as any).useSqlite;
    const tokenRecord = await findTokenByHash(provider.db, token, provider.schema, useSqlite);

    if (!tokenRecord) {
      return {
        valid: false,
        reason: 'Token not found'
      };
    }

    if (tokenRecord.expiresAt < new Date()) {
      return {
        valid: false,
        reason: 'Token expired'
      };
    }

    // Validate token format and length
    if (!token.startsWith('bct_') || token.length !== 52) {
      return {
        valid: false,
        reason: 'Invalid token format'
      };
    }

    const computedHash = await hashToken(token, tokenRecord.tokenSalt);

    const isValid = computedHash === tokenRecord.tokenHash;

    if (isValid) {
      await updateTokenLastUsed(provider, tokenRecord.id);
      const isInit = tokenRecord.initToken === true || tokenRecord.initToken === 1;
      return {
        valid: true,
        tokenInfo: {
          id: tokenRecord.id,
          expiresAt: tokenRecord.expiresAt,
          lastUsedAt: tokenRecord.lastUsedAt,
          ipAddresses: tokenRecord.ipAddresses,
          initToken: isInit
        }
      };
    }

    return {
      valid: false,
      reason: 'Invalid token'
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'Validation error'
    };
  }
}

// Extract the Bearer token from the Authorization header
export function extractAuthToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}

// Validate the Authorization header end-to-end
export async function validateAuthHeader(request: Request, provider: TokenValidationProvider): Promise<TokenValidationResult> {
  const token = extractAuthToken(request);
  if (!token) {
    return { valid: false, reason: 'Authorization header missing or malformed' };
  }
  return validateToken(token, provider);
}
