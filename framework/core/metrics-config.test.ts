import { describe, expect, it } from 'vitest';
import { getWorkerMetricsConfig, parseConfig, validateConfig } from './config';
import { generateWranglerConfig } from '../node/generate-wrangler-config';

const yaml = `
server: { name: neutral-app, version: 1.0.0, description: test }
cors: { origin: ['*'], allowMethods: ['GET'], allowHeaders: ['Content-Type'] }
metrics:
  enabled: true
  internal_token_binding: APP_INIT_TOKEN
workers:
  source-worker:
    name: source-worker
    handlers: [source]
    metrics: { enabled: true }
  metrics-worker:
    name: metrics-worker
    handlers: [observability]
    metrics: { enabled: true }
router: { name: router, routes: [] }
`;

describe('metrics configuration', () => {
  it('inherits global policy and generates SQLite cache bindings', () => {
    const config = parseConfig(yaml);
    validateConfig(config);
    const generated = generateWranglerConfig(config, 'worker', 'metrics-worker');
    expect(generated.durable_objects?.bindings).toContainEqual({ name: 'BOBRA_METRICS_COORDINATOR', class_name: 'BobraMetricsCoordinator' });
    expect(generated.migrations?.some((migration) => migration.new_sqlite_classes?.includes('BobraMetricsCoordinator'))).toBe(true);
    expect(generated.services).toContainEqual({ binding: 'SOURCE_WORKER', service: 'source-worker' });
  });

  it('keeps worker participation explicit and honors direct cache opt-out', () => {
    const config = parseConfig(yaml);
    config.workers['source-worker']!.metrics = { enabled: true, cache: { enabled: false } };
    expect(getWorkerMetricsConfig(config, 'source-worker').cache.enabled).toBe(false);
    expect(getWorkerMetricsConfig(config, 'unlisted-worker').enabled).toBe(false);
    const generated = generateWranglerConfig(config, 'worker', 'source-worker');
    expect(generated.durable_objects).toBeUndefined();
  });

  it('rejects enabled metrics without internal collection authentication', () => {
    const config = parseConfig(yaml.replace('  internal_token_binding: APP_INIT_TOKEN\n', ''));
    expect(() => validateConfig(config)).toThrow('metrics.internal_token_binding');
  });
});
