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
    await expect(collectObservabilityMetricGroups({ env, workerName: 'metrics', handlerName: 'observability' })).resolves.toEqual({ families: [], successfulProviders: 1 });
    const failedEnv = { ...env, SOURCE: { fetch: async () => new Response('no', { status: 503 }) } };
    const state = createState();
    const coordinator = new BobraMetricsCoordinator(state as never, failedEnv);
    await expect(coordinator.refresh()).rejects.toThrow('No metrics provider returned a successful response');
  });

  it('returns a valid stale merged snapshot when another refresh owns the coordinator lease', async () => {
    const state = createState();
    await state.storage.put('snapshot:merged', { collectedAt: Date.now(), families: [] });
    await state.storage.put('lease:merged', { holder: 'other', expiresAt: Date.now() + 10_000 });
    const config = `server: { name: test, version: '1', description: test }\ncors: { origin: ['*'], allowMethods: ['GET'], allowHeaders: ['Content-Type'] }\nmetrics: { enabled: true }\nworkers:\n  metrics: { name: metrics, handlers: [observability], metrics: { enabled: true } }\nrouter: { name: router, routes: [] }`;
    const coordinator = new BobraMetricsCoordinator(state as never, { CONFIG_CONTENT: config });
    await expect(coordinator.refresh()).resolves.toEqual({ collectedAt: expect.any(Number), families: [] });
  });
});

function createState() {
  const values = new Map<string, unknown>();
  return { storage: {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    setAlarm: async () => undefined,
  } };
}
