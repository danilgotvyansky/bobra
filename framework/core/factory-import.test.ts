import { describe, expect, it, vi } from 'vitest';
// This isolates an unrelated optional hono-openapi peer dependency. No cloudflare:workers mock is used.
vi.mock('hono-openapi', () => ({ generateSpecs: vi.fn() }));

describe('factory consumer import', () => {
  it('loads without a cloudflare:workers module mock', async () => {
    const { AppWorker } = await import('./factory');
    expect(AppWorker).toBeTypeOf('function');
  });
});
