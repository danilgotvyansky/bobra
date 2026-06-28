import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../core/config';
import { generateWranglerConfig } from './generate-wrangler-config';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    cors: {
      origin: ['*'],
      allowMethods: ['GET'],
      allowHeaders: ['Content-Type'],
    },
    server: {
      name: 'test-app',
      version: '0.1.0',
      description: 'Test app',
    },
    db_engine: 'postgres',
    pgEdge: {
      enabled: false,
      locations: [],
    },
    workers: {
      'api-worker': {
        name: 'api-worker',
        handlers: ['api'],
      },
    },
    router: {
      name: 'router-worker',
      main: 'src/router.ts',
      routes: [
        {
          path: '/api/*',
          service: 'api-worker',
        },
      ],
    },
    ...overrides,
  };
}

describe('generateWranglerConfig placement', () => {
  it('applies global placement to generated workers', () => {
    const wranglerConfig = generateWranglerConfig(
      baseConfig({ placement: { mode: 'smart' } }),
      'worker',
      'api-worker'
    );

    expect(wranglerConfig.placement).toEqual({ mode: 'smart' });
  });

  it('allows worker placement to override global placement', () => {
    const wranglerConfig = generateWranglerConfig(
      baseConfig({
        placement: { mode: 'smart' },
        workers: {
          'api-worker': {
            name: 'api-worker',
            handlers: ['api'],
            placement: { mode: 'off' },
          },
        },
      }),
      'worker',
      'api-worker'
    );

    expect(wranglerConfig.placement).toEqual({ mode: 'off' });
  });

  it('allows router placement to override global placement', () => {
    const wranglerConfig = generateWranglerConfig(
      baseConfig({
        placement: { mode: 'smart' },
        router: {
          name: 'router-worker',
          main: 'src/router.ts',
          routes: [],
          placement: { mode: 'targeted', region: 'wnam' },
        },
      }),
      'router',
      'router-worker'
    );

    expect(wranglerConfig.placement).toEqual({ mode: 'targeted', region: 'wnam' });
  });

  it('passes through targeted host and hostname placement hints', () => {
    const hostConfig = generateWranglerConfig(
      baseConfig({ placement: { mode: 'targeted', host: 'db.internal.example' } }),
      'worker',
      'api-worker'
    );

    const hostnameConfig = generateWranglerConfig(
      baseConfig({ placement: { mode: 'targeted', hostname: 'api.example.com' } }),
      'worker',
      'api-worker'
    );

    expect(hostConfig.placement).toEqual({ mode: 'targeted', host: 'db.internal.example' });
    expect(hostnameConfig.placement).toEqual({ mode: 'targeted', hostname: 'api.example.com' });
  });
});
