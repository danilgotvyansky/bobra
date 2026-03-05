# Handlers - Guide

## Create a new Handler

1. Create directory: `mkdir src/handlers/myhandler`
2. Create `src/handlers/myhandler/index.ts`:

```typescript
import { Hono } from 'hono';
import type { AppHandler } from '@bobra/framework/core';
import { ensureApiToken } from '@bobra/framework/middleware';
// other imports...

const routes = new Hono<{ Bindings: Env }>()
  .use('*', ensureApiToken()) 

  .get(
    '/',
    describeRoute({
      description: 'Get generic resources',
      parameters: valibotSchemaToOpenAPIParameters(defaultQuerySchema),
      responses: {
        200: {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: generateListResponseSchema('GenericResource')
            }
          },
        },
      },
    }),
    vValidator('query', defaultQuerySchema),
    async (c) => {
      const env = c.env as Env;
      const resources = await listResources(env);
      return c.json({ success: true, data: resources });
    }
  )

const myHandler: AppHandler = {
  name: 'myhandler',
  version: '0.1.0',
  routes,
  componentSchemas: componentSchemas,
  initLogger: (config, context, worker, handler) => {
    initializeLogger(config, context, worker);
    if (handler) getLogger().setHandler(handler);
  },
  init: async (_env) => { }
};

export default myHandler;
```

3. Define schemas in `src/handlers/myhandler/schemas.ts`. [OpenAPI](../09-openapi/openapi.md)
4. Define business logic service functions in `src/handlers/myhandler/service.ts`.
5. Define database functions in `src/handlers/myhandler/db.ts`.

> [!TIP]
> Use example-app to check how to define componentSchemas, business logic service functions, etc.

## Register in Worker

Update `src/workers/main-worker/index.ts`:

```typescript
import { createCloudflareWorker, createHandlerArray } from '@bobra/framework/core';
// other handler imports...
import myHandler from '../../../handlers/myhandler/src/index';

export default createCloudflareWorker('main-worker', createHandlerArray(
  // other handlers...
  myHandler
));
```

## Register in Config

Update `config.yml`:

```yaml
workers:
  main-worker:
    handlers: 
      - myhandler
# ...
router:
  name: 'router-worker'
# ...
  routes:
# Other handlers' routes...
    - path: '/api/myhandler*'
      service: 'main-worker'
```

> [!NOTE]
> Default base path for worker is `/api` and for router is `/`.

## Test Locally

Update package.json scripts to include a new worker

```
"dev:all": "pnpm exec wrangler -c router/router-worker/wrangler.jsonc -c workers/main-worker/wrangler.jsonc dev --local --persist-to=${LOCAL_WRANGLER_DIR}",
```

## Advanced:

### SpaHandler

The `createSpaHandler` utility creates a specialized handler for serving static Single Page Applications (SPAs). It handles asset serving, content-type detection, and client-side routing fallbacks.

Typically you would put your SPA code to `frontends/your-app` and define handler directly in worker without creating one in `handlers/`

```typescript
// workers/main-worker
import { createSpaHandler } from '@bobra/framework';

const dashboardHandler = createSpaHandler({
  name: 'actions',
  indexHtml: 'index.html',
  assetsBinding: 'ASSETS',
  ignoreWorkerBasePath: true
});
```

Key features of `SpaHandler`:
- **Asset Serving**: Automatically serves JS, CSS, and images from the binding.
- **SPA Fallback**: Redirects unknown paths within the `basePath` to `index.html`.
- **Recursion Guard**: Prevents infinite loops if the handler is accidentally misconfigured to call itself.

[Queues](./queues.md)
