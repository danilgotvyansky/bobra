import { describe, expect, it } from 'vitest';
import { BobraMetricsCoordinator, collectObservabilityMetricGroups, mergeMetricFamilies, parseMetricsDuration, serializePrometheus } from './index';

describe('metrics battery', () => {
  it('serializes stable Prometheus 0.0.4 text', () => {
    expect(serializePrometheus([{ name: 'example_value', help: 'an example', type: 'gauge', samples: [{ labels: { z: 'two', a: 'one' }, value: 2 }] }]))
      .toBe('# HELP example_value an example\n# TYPE example_value gauge\nexample_value{a="one",z="two"} 2\n');
  });

  it('omits conflicting samples and incompatible families', () => {
    expect(mergeMetricFamilies([
      [{ name: 'same', help: 'help', type: 'gauge', samples: [{ labels: { a: '1' }, value: 1 }] }],
      [{ name: 'same', help: 'help', type: 'gauge', samples: [{ labels: { a: '1' }, value: 2 }] }],
      [{ name: 'same', help: 'help', type: 'gauge', samples: [{ labels: { a: '1' }, value: 1 }] }],
      [{ name: 'broken', help: 'one', type: 'gauge', samples: [] }],
      [{ name: 'broken', help: 'two', type: 'gauge', samples: [] }],
    ])).toEqual([{ name: 'same', help: 'help', type: 'gauge', samples: [] }]);
  });

  it('parses configured durations', () => {
    expect(parseMetricsDuration('1.5m')).toBe(90_000);
    expect(() => parseMetricsDuration('forever')).toThrow('Invalid metrics duration');
  });

  it('treats an empty successful provider response as valid but all failures as an error', async () => {
    const config = `server: { name: test, version: '1', description: test }\ncors: { origin: ['*'], allowMethods: ['GET'], allowHeaders: ['Content-Type'] }\nmetrics: { enabled: true, internal_token_binding: APP_TOKEN }\nworkers:\n  source: { name: source, handlers: [source], metrics: { enabled: true } }\n  metrics: { name: metrics, handlers: [observability], metrics: { enabled: true } }\nrouter: { name: router, routes: [] }`;
    const env = { CONFIG_CONTENT: config, APP_TOKEN: 'secret', SOURCE: { fetch: async () => new Response(JSON.stringify({ families: [] })) } };
    await expect(collectObservabilityMetricGroups({ env, workerName: 'metrics', handlerName: 'observability' })).resolves.toEqual({ families: [], successfulProviders: 1, expectedProviders: 1 });
    const failedEnv = { ...env, SOURCE: { fetch: async () => new Response('no', { status: 503 }) } };
    const state = createState();
    const coordinator = new BobraMetricsCoordinator(state as never, failedEnv);
    await expect(coordinator.refresh()).rejects.toThrow('No metrics provider returned a successful response');
  });

  it('shares a concurrent coordinator refresh without Durable Object lease storage', async () => {
    const state = createState();
    let requests = 0;
    let resolveRequest: (() => void) | undefined;
    const config = `server: { name: test, version: '1', description: test }\ncors: { origin: ['*'], allowMethods: ['GET'], allowHeaders: ['Content-Type'] }\nmetrics: { enabled: true }\nworkers:\n  source: { name: source, handlers: [source], metrics: { enabled: true } }\n  metrics: { name: metrics, handlers: [observability], metrics: { enabled: true } }\nrouter: { name: router, routes: [] }`;
    const coordinator = new BobraMetricsCoordinator(state as never, {
      CONFIG_CONTENT: config,
      SOURCE: { fetch: async () => {
        requests += 1;
        await new Promise<void>((resolve) => { resolveRequest = resolve; });
        return new Response(JSON.stringify({ families: [] }));
      } },
    });
    const first = coordinator.refresh();
    const second = coordinator.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toBe(1);
    resolveRequest?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { collectedAt: expect.any(Number), families: [] },
      { collectedAt: expect.any(Number), families: [] },
    ]);
    expect(state.operations.some((operation) => operation.startsWith('put:lease:'))).toBe(false);
  });

  it('keeps a loaded snapshot in memory and avoids repeated Durable Object reads', async () => {
    const state = createState();
    await state.storage.put('snapshot:merged', { collectedAt: 1, families: [] });
    const coordinator = new BobraMetricsCoordinator(state as never, {});
    await coordinator.readMergedSnapshot();
    await coordinator.readMergedSnapshot();
    expect(state.operations.filter((operation) => operation === 'get:snapshot:merged')).toHaveLength(1);
  });
});

function createState() {
  const values = new Map<string, unknown>();
  const operations: string[] = [];
  return { operations, storage: {
    get: async <T>(key: string) => { operations.push(`get:${key}`); return values.get(key) as T | undefined; },
    put: async <T>(key: string, value: T) => { operations.push(`put:${key}`); values.set(key, value); },
    delete: async (key: string) => { operations.push(`delete:${key}`); return values.delete(key); },
    setAlarm: async () => { operations.push('setAlarm'); },
  } };
}
