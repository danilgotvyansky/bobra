# OpenAPI & Schema Management

Bobra leverages Hono's OpenAPI integration and Valibot to provide automated, type-safe API documentation.

## Shared Schemas

To ensure consistency across multiple handlers, commonly shared schemas (e.g., User, Organization, Error Responses) should be defined centrally in your application's `shared-utils`.

### Location
By convention, shared schemas are defined in `shared-utils/src/openapi/schemas.ts` (or `core.ts` in some projects).

### Automatic Generation from Database
Bobra integrates with `drizzle-valibot` to automatically generate Valibot schemas from your database table definitions.

```typescript
import { createSelectSchema } from 'drizzle-valibot';
import { schema } from '../db/schema';

export const userSchema = createSelectSchema(schema.users);
```

## Schema Reflection in Handlers

Each individual handler should expose an `/openapi` endpoint that merges these shared schemas with its own local endpoints.

### The Re-import Pattern
To ensure that shared schemas appear correctly in a handler's specific OpenAPI documentation, you must re-import and re-export them within the handler's schema definition.

```typescript
// in handlers/users/src/schemas.ts
export { userSchema } from 'shared-utils/openapi/core';

// Add handler-specific schemas here
export const updateProfileSchema = v.object({ ... });
```

## Defining Routes

Use `describeRoute` to provide metadata for your endpoints and `vValidator` for request validation.

```typescript
import { describeRoute } from 'hono-openapi';
import { vValidator } from '@hono/valibot-validator';
import { 
  valibotSchemaToOpenAPIParameters, 
  generateListResponseSchema 
} from '@bobra/framework/batteries/openapi';

const routes = new Hono<{ Bindings: Env }>()
  .get(
    '/',
    describeRoute({
      description: 'Get generic resources',
      // Manual parameter override if needed, but vValidator handled automatically
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
    // CRITICAL: vValidator is detected by hono-openapi to populate 
    // the OpenAPI 'parameters' and 'requestBody' automatically.
    vValidator('query', defaultQuerySchema),
    async (c) => {
      const env = c.env as Env;
      const resources = await listResources(env);
      return c.json({ success: true, data: resources });
    }
  )
```

## OpenAPI Utilities

Bobra provides several utilities in `@bobra/framework/batteries/openapi` to simplify schema management:

### `valibotSchemaToOpenAPIParameters`
Automatically converts a Valibot object schema into an array of OpenAPI parameter objects. This is useful for `query` or `path` parameters when you need to manually override or complement the automatic discovery.

### `generateListResponseSchema`
Creates a standardized JSON schema for list responses. It wraps your item schema in a consistent structure:
```json
{
  "success": "boolean",
  "data": "array<ItemSchema>",
  "count": "number"
}
```

### `generateSchemaRef`
A helper to generate a `$ref` object pointing to a component schema (e.g., `#/components/schemas/User`). Use this when referencing shared schemas in nested objects.

## Merging & Viewing Documentation

The Bobra `api-docs` handler (or the global router) provides several out-of-the-box endpoints for interacting with your API documentation:

- **`/openapi`**: Returns the raw, merged OpenAPI JSON specification.
- **`/swagger`**: Serves the interactive **Swagger UI**.
- **`/scalar`**: Serves the modern **Scalar API Reference**.
- **`/llms.txt`**: Serves a Markdown representation of your API, optimized for ingestion by LLMs and AI agents (see [llmstxt.org](https://llmstxt.org/)).

### How it works
1.  **Handlers** export their local spec via `/openapi`.
2.  **Router** (or Docs Handler) fetches specs from all handlers via `serviceFetch`.
3.  **Docs Handler** merges the JSON objects and serves the unified UI and LLM endpoints.
