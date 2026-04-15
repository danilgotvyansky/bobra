# Wrangler Config Extensions Guide

Use wrangler config extensions when your app needs extra `config.yml` fields and custom mapping logic into generated `wrangler.jsonc`.

This guide shows how to:
- wire an app wrapper around the framework generator,
- define a typed extension,
- validate custom config shape,
- map custom fields (including observability traces/log destinations),
- use all available extension hooks.

## 1) Wrap Framework `main()`

Create or update your app script (for example, `scripts/generate-wrangler-config.ts`):

```ts
#!/usr/bin/env tsx

import { main } from '@danylohotvianskyi/bobra-framework/node';
import { appWranglerConfigExtension } from './generate-wrangler-config.extension';

main({ extension: appWranglerConfigExtension });
```

## 2) Define Extension Logic

Create a separate extension module (for example, `scripts/generate-wrangler-config.extension.ts`):

```ts
import {
  defineWranglerConfigExtension,
  type AppConfig,
  type WranglerConfig,
} from '@danylohotvianskyi/bobra-framework/node';

interface AppConfigWithExtensions extends AppConfig {
  wrangler_extensions?: {
    router?: Partial<WranglerConfig>;
    workers?: Record<string, Partial<WranglerConfig>>;
  };
}

export const appWranglerConfigExtension = defineWranglerConfigExtension<
  AppConfigWithExtensions,
  WranglerConfig
>({
  validateConfig(config) {
    if (config.wrangler_extensions && typeof config.wrangler_extensions !== 'object') {
      throw new Error('wrangler_extensions must be an object');
    }
  },

  extendWranglerConfig({ config, workerType, workerName, wranglerConfig }) {
    const patch = workerType === 'router'
      ? config.wrangler_extensions?.router
      : config.wrangler_extensions?.workers?.[workerName];

    if (!patch) return wranglerConfig;
    return { ...wranglerConfig, ...patch };
  },
});
```

## 3) Configure Custom Mapping Fields

Add app-level mapping fields in `config.yml`:

```yaml
wrangler_extensions:
  router:
    observability:
      traces:
        enabled: true
        destinations:
          - grafana-traces
      logs:
        enabled: true
        destinations:
          - grafana-logs
```

Per-worker override:

```yaml
wrangler_extensions:
  workers:
    1stline-proxy-worker:
      observability:
        traces:
          enabled: true
          destinations:
            - grafana-traces
        logs:
          enabled: true
          destinations:
            - grafana-logs
```

## 4) Resulting `wrangler.jsonc` Shape

The generated output can include:

```jsonc
{
  "observability": {
    "traces": {
      "enabled": true,
      "destinations": ["grafana-traces"]
    },
    "logs": {
      "enabled": true,
      "destinations": ["grafana-logs"]
    }
  }
}
```

## Extension Hooks

- `validateConfig(config)`: validate app-specific fields before generation.
- `extendWranglerConfig(context)`: mutate/merge final config for router or worker.
- `serializeOutput(wranglerConfig)`: customize output serializer.
- `onBeforeWrite(context)`: run side effects before file write.
- `onAfterWrite(context)`: run side effects after file write.
