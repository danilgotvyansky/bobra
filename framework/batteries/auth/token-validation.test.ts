import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateToken, type TokenRecord } from './token-validation';
import { findTokenByHash, hashToken } from './hash';
import { updateTokenLastUsed } from './token-metadata';

vi.mock('./hash', () => ({
  findTokenByHash: vi.fn(),
  hashToken: vi.fn(),
}));

vi.mock('./token-metadata', () => ({
  updateTokenLastUsed: vi.fn(),
}));

const validToken = 'bct_123456789012345678901234567890123456789012345678';

function tokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    uid: 'token-uid',
    tokenHash: 'expected-hash',
    tokenSalt: 'salt',
    expiresAt: new Date(Date.now() + 60_000),
    initToken: false,
    ...overrides,
  };
}

describe('validateToken', () => {
  beforeEach(() => {
    vi.mocked(findTokenByHash).mockReset();
    vi.mocked(hashToken).mockReset();
    vi.mocked(updateTokenLastUsed).mockReset();
    vi.mocked(hashToken).mockResolvedValue('expected-hash');
  });

  it('accepts init tokens without expiration', async () => {
    vi.mocked(findTokenByHash).mockResolvedValue(tokenRecord({ expiresAt: null, initToken: true }));

    const result = await validateToken(validToken, {} as never);

    expect(result.valid).toBe(true);
    expect(result.tokenInfo?.initToken).toBe(true);
    expect(result.tokenInfo?.expiresAt).toBeNull();
    expect(updateTokenLastUsed).toHaveBeenCalledWith({}, 'token-uid');
  });

  it('rejects init tokens with an expiration timestamp in the past', async () => {
    vi.mocked(findTokenByHash).mockResolvedValue(tokenRecord({
      expiresAt: new Date(Date.now() - 60_000),
      initToken: true,
    }));

    const result = await validateToken(validToken, {} as never);

    expect(result).toEqual({ valid: false, reason: 'Token expired' });
  });

  it('accepts regular API tokens without expiration', async () => {
    vi.mocked(findTokenByHash).mockResolvedValue(tokenRecord({ expiresAt: null, initToken: false }));

    const result = await validateToken(validToken, {} as never);

    expect(result.valid).toBe(true);
    expect(result.tokenInfo?.expiresAt).toBeNull();
  });
});
