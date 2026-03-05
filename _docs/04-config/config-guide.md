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
          binding: "HYPERDRIVE_EU"
          id: "..."
      d1:
        binding: "D1_INSTANCE"
    services:
      - binding: "ROUTER"
        service: "main-router"
```

### Router Configuration

The `router` section configures the ingress worker that proxies traffic to other industrial workers.

```yaml
router:
  name: "main-router"
  base_path: "/"
  routes:
    - path: "/api/users*"
      service: "users-worker"
  services:
    - binding: "EXTERNAL_API"
      external_url: "https://api.external.com"
```

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

## Synchronizing Configs

Bobra uses the `config.yml` to generate the necessary `wrangler.production.jsonc` files for each worker.

Create locally excluded `config.local.yml` to generate `wrangler.jsonc` for local development

### Generation Script
Run the sync script before development or deployment:
```bash
pnpm run dev:generate-configs
```

## Local Development

For local development, create a `.dev.vars` or `.env` file at the root of your project to provide secrets and environment-specific values that should not be committed to version control.

These files will be automatically discovered and copied to each worker to inject vars natively.
