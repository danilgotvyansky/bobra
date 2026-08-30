import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { parseConfig } from './config';
// This isolates an unrelated optional hono-openapi peer dependency. No cloudflare:workers mock is used.
vi.mock('hono-openapi', () => ({ generateSpecs: vi.fn() }));

describe('factory consumer import', () => {
  it('loads without a cloudflare:workers module mock', async () => {
    const { AppWorker } = await import('./factory');
    expect(AppWorker).toBeTypeOf('function');
  });

  it('allows a metrics provider when the global metrics kill switch is off', async () => {
    const { AppWorker } = await import('./factory');
    const config = parseConfig(`server: { name: test, version: '1', description: test }\ncors: { origin: ['*'], allowMethods: ['GET'], allowHeaders: ['Content-Type'] }\nmetrics: { enabled: false }\nworkers:\n  source: { name: source, handlers: [source], metrics: { enabled: true } }\nrouter: { name: router, routes: [] }`);
    const worker = new AppWorker(new Hono() as never, config, 'source', '/');
    await expect(worker.add({ default: { name: 'source', version: '1', routes: new Hono() as never, metrics: { collect: async () => [] } } })).resolves.toBe(worker);
  });
});
