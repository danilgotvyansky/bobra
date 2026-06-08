import { describe, expect, it, vi } from 'vitest';
import { createPublicApiToken } from './token';

vi.mock('./hash', () => ({
  hashToken: vi.fn(async () => 'hashed-token'),
}));

describe('createPublicApiToken', () => {
  it('creates non-expiring init tokens by default', async () => {
    const { record } = await createPublicApiToken({ initToken: true, name: 'Initial Instance Token' });

    expect(record.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(record.initToken).toBe(true);
    expect(record.expiresAt).toBeNull();
  });

  it('keeps expiration on regular API tokens by default', async () => {
    const { record } = await createPublicApiToken({ name: 'Regular API Token' });

    expect(record.initToken).toBe(false);
    expect(record.expiresAt).toEqual(expect.any(String));
  });
});
