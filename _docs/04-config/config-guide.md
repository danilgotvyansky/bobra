# Configuration Guide

The `config.yml` file is the central source of truth for your Bobra application. It defines the structure, behavior, and infrastructure requirements for all workers and services in your product.

## The `config.yml` Structure

The configuration is divided into global settings and specific configurations for `workers` and the `router`.

### Global Settings

#### `server`
Defines the identity of your application.
```yaml
server:
  name: "MyApplication"
  version: "0.1.0"
  description: "A Bobra-powered modular application"
```

#### `cors`
Global CORS configuration applied to all incoming requests.
```yaml
cors:
  origin: ["https://myapp.com"]
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  allowHeaders: ["Content-Type", "Authorization", "X-Org-Context"]
```

#### `db_engine` & `pgEdge`
Controls the database strategy for the entire app.
```yaml
db_engine: "postgres" # "postgres", "d1-sqlite", or "auto-detect"
pgEdge:
  enabled: true
  locations: ["eu", "us"]
```

#### `vars`
Global environment variables accessible to all workers.
```yaml
vars:
  API_BASE_URL: "https://api.myapp.com"
```

#### `placement`
Global Cloudflare Worker placement applied to the router and every worker unless overridden.

```yaml
placement:
  mode: "smart"
```

To disable placement globally:

```yaml
placement:
  mode: "off"
```

To use explicit targeted placement hints:

```yaml
placement:
  mode: "targeted"
  region: "aws:eu-central-1"
```

Targeted placement accepts one of `region`, `host`, or `hostname`.

### Worker Configuration

The `workers` map defines individual Cloudflare Workers and their handlers, databases, and dependencies.

```yaml
workers:
  users-worker:
    name: "users-api"
    handlers: ["users", "profiles"]
    database:
      postgres:
        eu:
          default:
            binding: "HYPERDRIVE_EU"
            id: "..."
          live:
            binding: "HYPERDRIVE_EU_LIVE"
            id: "..."
      d1:
        binding: "D1_INSTANCE"
    services:
      - binding: "ROUTER"
        service: "main-router"
    placement:
      mode: "off"
```

Worker-level `placement` overrides global `placement` for that worker.

### Postgres Binding Shapes

`database.postgres` supports multiple shapes:

```yaml
# Single binding (works for single-postgres deployments)
postgres:
  binding: "POSTGRES"
  id: "..."

# Multi-location bindings (classic pgEdge)
postgres:
  eu:
    binding: "POSTGRES_EU"
    id: "..."
  us:
    binding: "POSTGRES_US"
    id: "..."

# Role-based bindings for a location (default + fresh/live)
postgres:
  eu:
    default:
      binding: "POSTGRES_EU"
      id: "..."
    live:
      binding: "POSTGRES_EU_LIVE"
      id: "..."
```

Roles are fully convention-based; Bobra does not enforce specific names. `live` is a common choice for read-after-write-sensitive paths where cached data is unacceptable.

### Runtime Role Selection

You can select a Postgres binding role at runtime:

```typescript
const db = getDb(env, schema, { postgresBindingRole: 'live' });
```

Binding resolution order for pgEdge location `eu` with role `live`:
1. `POSTGRES_EU_LIVE`
2. `POSTGRES_EU`
3. `POSTGRES_EU_DEFAULT`

Binding resolution order for single-postgres mode with role `live`:
1. `POSTGRES_LIVE`
2. `POSTGRES`
3. `POSTGRES_DEFAULT`

### Router Configuration

The `router` section configures the ingress worker that proxies traffic to other industrial workers.

```yaml
router:
  name: "main-router"
  base_path: "/"
  placement:
    mode: "targeted"
    hostname: "api.myapp.com"
  routes:
    - path: "/api/users*"
      service: "users-worker"
  services:
    - binding: "EXTERNAL_API"
      external_url: "https://api.external.com"
```

Router-level `placement` overrides global `placement` for the router worker.

## Environment Variable Resolution

Bobra supports `$VAR` and `${VAR}` syntax for injecting values from the environment.

```yaml
postgres:
  binding: "POSTGRES"
  id: "..."
  localConnectionString: ${DATABASE_URL}
```

### Resolution Priority
1.  **Cloudflare Secrets**: Used in production.
2.  **.dev.vars** or **.env**: Used during local development.
3.  **Hardcoded fallbacks**: If specified.

### pgEdge Runtime Failover Vars

When using PostgreSQL with multiple pgEdge candidates, you can tune runtime failover with:

- `PGEDGE_FAILOVER_ENABLED` (default: `true` when more than one candidate exists)
- `PGEDGE_FAILOVER_CONNECTION_TIMEOUT_MS` (default: `2000`)
- `PGEDGE_FAILOVER_WARN_LOGGING` (default: `true`)

These are runtime env vars (for example Cloudflare vars/secrets), not `config.yml` keys.

## Synchronizing Configs

Bobra uses the `config.yml` to generate the necessary `wrangler.production.jsonc` files for each worker.

Create locally excluded `config.local.yml` to generate `wrangler.jsonc` for local development

### Generation Script
Run the sync script before development or deployment:
```bash
pnpm run dev:generate-configs
```

## Extending Wrangler Config Generation

Use the dedicated guide for extension setup, typed hook examples, and observability mapping:

- [Wrangler Config Extensions Guide](./wrangler-extensions-guide.md)

## Local Development

For local development, create a `.dev.vars` or `.env` file at the root of your project to provide secrets and environment-specific values that should not be committed to version control.

These files will be automatically discovered and copied to each worker to inject vars natively.
