import { describe, expect, it, vi } from 'vitest';
import { createPublicApiToken } from './token';

vi.mock('./hash', () => ({
  hashToken: vi.fn(async () => 'hashed-token'),
}));

describe('createPublicApiToken', () => {
  it('creates non-expiring init tokens by default', async () => {
    const { record } = await createPublicApiToken({ initToken: true, name: 'Initial Instance Token' });

    expect(record.initToken).toBe(true);
    expect(record.expiresAt).toBeNull();
  });

  it('keeps expiration on regular API tokens by default', async () => {
    const { record } = await createPublicApiToken({ name: 'Regular API Token' });

    expect(record.initToken).toBe(false);
    expect(record.expiresAt).toEqual(expect.any(String));
  });
});
