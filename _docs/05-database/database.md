# Database Guide

Bobra supports a dual-database architecture, allowing you to run the same business logic on both PostgreSQL (e.g., pgEdge) and SQLite (e.g., Cloudflare D1).

## Table Definitions

Every table in your schema must be defined for both PostgreSQL and SQLite. By convention, SQLite tables use a `Sqlite` suffix in their variable name but share the same SQL table name.

```typescript
import { pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// PostgreSQL Table
export const users = pgTable('users', {
  uid: pgText('uid').primaryKey(),
  email: pgText('email').notNull(),
});

// SQLite Table
export const usersSqlite = sqliteTable('users', {
  uid: text('uid').primaryKey(),
  email: text('email').notNull(),
});
```

### Type Mapping Recommendations
| Type | PostgreSQL | SQLite |
| :--- | :--- | :--- |
| UUID / Text | `varchar(36)` / `text` | `text` |
| Boolean | `pgBoolean` | `integer` (0/1) |
| JSON | `jsonb` | `text` (store as string) |
| Timestamp | `timestamp` | `text` (ISO 8601) |

## The Schema Object

To leverage Drizzle's type safety and relational features, you must aggregate all your table definitions into a single `schema` object.

### Implementation
In your `schema.ts`, export all tables. Then, in your database client (`index.ts`), import them collectively:

```typescript
// shared-utils/src/db/index.ts
import * as schema from './schema';
import { getDb as _getDb } from '@danylohotvianskyi/bobra-framework/db';

export function getDb(env: AppEnvBindings) {
  // Passing 'schema' enables type-safe queries: db.query.users.findFirst(...)
  return _getDb(env, schema);
}
```

By providing the `schema` object to `getDb`, you enable:
1.  **Relational Queries**: Use the `db.query` API for nested data fetching.
2.  **Type Safety**: Automatic type inference for query results and filters.
3.  **Intellisense**: IDE support for table and column names across your handlers.

## Migrations

Bobra uses Drizzle Kit for migrations. However, because of the dual-DB requirement and specific engine features, migrations are structured into two separate directories:
- `shared-utils/src/db/migrations-pg/`
- `shared-utils/src/db/migrations-sqlite/`

### Running Migrations
The `migrate.ts` script automatically detects the engine and applies the correct migrations.

```bash
# Apply migrations to local/remote D1
pnpm run migrate -- --local

# Apply migrations to PostgreSQL
DB_ENGINE=postgres pnpm run migrate
```

## Full-Text Search (FTS5) & Manual SQL

Drizzle does not currently support SQLite `VIRTUAL TABLE` or FTS5 syntax in its schema definition. To implement fast search:

1.  **Define a standard table** in `schema.ts` for TypeScript type support.
2.  **Manually modify the SQL migration** after it is generated. Change `CREATE TABLE` to `CREATE VIRTUAL TABLE ... USING fts5`.
3.  **Add Triggers**: Use manual SQL in your migration to create triggers that keep your virtual FTS table in sync with the main data table.

## Init Token Generation

Bobra includes a built-in mechanism for generating an **Initial Instance Token (Init Token)**. This is a special, high-privilege token used to bootstrap your application.

### How it works
1.  During the first migration, the `migrate` script checks if an init token has been created.
2.  It uses the `init_token_created` singleton table to track status.
3.  If missing, it generates a cryptographically secure token, stores it with `expires_at = NULL`, and prints it to the console (STDOUT).
4.  **Expiration**: Init tokens do not expire. A nullable `expires_at` column is the supported representation for never-expiring tokens.
5.  **Security**: The init token is ONLY generated during migrations. Handlers cannot create it. Store this token securely; it is your "root" access to the API.

## pgEdge & Location Routing

When using PostgreSQL with [pgEdge](https://www.pgedge.com/), Bobra can automatically route requests to the nearest geographical node.

### Location Decisions
The `getDb(env)` utility uses Cloudflare's `cfInfo` (colo and continent) to determine the nearest database instance.

### Runtime Failover (pgEdge)

For pgEdge setups with multiple resolved Postgres candidates, Bobra performs runtime failover at the PostgreSQL driver boundary:

1. Build ordered candidates: router-preferred location first, then remaining locations.
2. Resolve each location binding using existing role-aware binding rules.
3. Create lazy `pg.Pool` instances per candidate.
4. Execute queries/connection acquisition on the first candidate and retry next candidates only on transient connection/location-unavailable errors.

This keeps the fast path local: when the primary location is healthy, requests stay on that location and do not fan out.

#### What triggers failover

Failover retries are limited to transient connectivity/unavailable classes:

- Node/network codes: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `UND_ERR_*`
- SQLSTATE class `08*`
- SQLSTATE `57P01`, `57P02`, `57P03`
- Hyperdrive-like SQLSTATE `58000` when message indicates transient pool/connection acquisition failure (for example `pool acquisition` or `server connection attempt failed`)

Regular SQL/query errors (syntax, constraint violations, etc.) do not trigger failover.

#### Transactions and failover

Fallback is allowed only during transaction acquisition (`connect` stage). Once a transaction starts on one candidate, Bobra does not fail over mid-transaction.

#### Failover env toggles

- `PGEDGE_FAILOVER_ENABLED`:
  default `true` when more than one candidate is available
- `PGEDGE_FAILOVER_CONNECTION_TIMEOUT_MS`:
  default `2000` ms for candidate pool connection attempts in failover mode
- `PGEDGE_FAILOVER_WARN_LOGGING`:
  default `true`; warn logs on every runtime fallback to the next candidate

If all candidates fail, Bobra throws the last error and emits a summary error log with attempted bindings.

### Role-Aware Binding Selection

Bobra supports selecting a Postgres binding role per query path, while keeping location routing.

Example for read-after-write-sensitive operations:

```typescript
const db = getDb(env, schema, { postgresBindingRole: 'live' });
```

When `pgEdge.locations` includes `eu`, Bobra resolves candidates in this order:
1. `POSTGRES_EU_<ROLE>` (for example `POSTGRES_EU_LIVE`)
2. `POSTGRES_EU`
3. `POSTGRES_EU_DEFAULT`

In single-postgres mode (no pgEdge locations), candidates are:
1. `POSTGRES_<ROLE>` (for example `POSTGRES_LIVE`)
2. `POSTGRES`
3. `POSTGRES_DEFAULT`

This allows separate Hyperdrive configs (for example cached vs non-cached) without introducing artificial locations or SQL cache-bypass clauses.

Using a separate non-cached Hyperdrive is explicitly recommended by Cloudflare in [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)

### Config Shapes

`database.postgres` supports all of the following:

```yaml
# Single binding
postgres:
  binding: "POSTGRES"
  id: "..."

# Per-location
postgres:
  eu:
    binding: "POSTGRES_EU"
    id: "..."
  us:
    binding: "POSTGRES_US"
    id: "..."

# Per-location with roles
postgres:
  eu:
    default:
      binding: "POSTGRES_EU"
      id: "..."
    live:
      binding: "POSTGRES_EU_LIVE"
      id: "..."
```

You can also utilize role logic for creating reader/writer db role splits in your application.

### Customization
You can customize the routing logic in your database client implementation:
- **Global Config**: Define `pgEdge.locations` in `config.yml`.
- **Custom Logic**: Override the `targetLocation` logic in `db-utils.ts` to support specific regional requirements or failover strategies.

> [!TIP]
> Review [example-app](../../example-app/shared-utils/src/db/index.ts) for customPgEdge implementation example
