# Metrics

Bobra exposes Prometheus text metrics through one central `observability` Worker. Business handlers provide metric families; the central Worker collects and merges them at one scrape endpoint. Do not expose public `/metrics` endpoints on every Worker: the scraper calls one endpoint and Bobra uses private Service Bindings for fan-out.

```text
Prometheus / VMagent
        │ one public scrape
        ▼
observability Worker ── Service Binding ──► source Worker providers
        │                                      │
        └──── Durable Object snapshot ◄────────┘
```

## Recommended setup

```yaml
metrics:
  enabled: true
  endpoint_path: "/metrics"
  internal_token_binding: "APP_METRICS_INTERNAL_TOKEN"
  cache:
    enabled: true
    backend: "durable-object"
    freshness: "1m"
    max_staleness: "5m"
    provider_timeout: "10s"

workers:
  api-worker:
    handlers: [api]
    metrics: { enabled: true }
    secrets:
      required: ["APP_METRICS_INTERNAL_TOKEN"]
  observability-worker:
    handlers: [observability]
    metrics: { enabled: true }
    secrets:
      required: ["APP_METRICS_INTERNAL_TOKEN"]
```

The central Worker entrypoint must export a coordinator:

```ts
import { DurableObject } from 'cloudflare:workers';
import {
  createBobraMetricsCoordinatorClass,
  type MetricsDurableObjectConstructor,
} from '@danylohotvianskyi/bobra-framework/batteries/metrics';

export class BobraMetricsCoordinator extends createBobraMetricsCoordinatorClass(
  DurableObject as unknown as MetricsDurableObjectConstructor,
) {}
```

When caching is enabled, the config generator adds the Durable Object bindings and migration. See the [example](../../example-app/workers/example-app-observability-worker/src/index.ts).

`APP_METRICS_INTERNAL_TOKEN` is the name of a runtime secret binding. Declare it under `secrets.required` on every metrics-enabled Worker and give it the same opaque value in each Worker. Bobra validates the declaration during local development/deployment but never copies the value into generated config. It authenticates only Bobra's private collection protocol: do not reuse an API/user token and do not send it from Prometheus. Locally, copy each metrics-enabled Worker's `.dev.vars.example` to `.dev.vars` and set the shared value.

## Configuration reference

Global `metrics` supplies defaults. Every participating Worker must explicitly use `workers.<name>.metrics.enabled: true`; global `enabled: false` is a master off switch. Nested objects merge, so worker settings may override only one field.

| Option | What it controls | Important behaviour |
| --- | --- | --- |
| `enabled` | Global battery activation and per-Worker participation. | Both global and Worker values must be true. A participating Worker needs a handler with a metrics provider. |
| `endpoint_path` | Prometheus response path appended to each handler's path. | Must begin with `/`; use `/metrics` normally. Only route the central endpoint publicly. |
| `internal_token_binding` | Environment variable name holding the shared collection secret. | Required whenever metrics are enabled. It is read from a Worker secret or `.dev.vars`, never copied into generated config. |
| `cache.enabled` | Enables DO snapshots and refresh coordination. | Recommended on Cloudflare. `false` selects fully live collection and produces no metrics DO resources. |
| `cache.backend` | Snapshot implementation. | `durable-object` is the only supported cached backend. |
| `cache.freshness` | Maximum snapshot age before the next request refreshes it; also normal coordinator alarm cadence. | Lower gives newer metrics and more source Worker/database work. Durations accept `ms`, `s`, `m`, `h`. |
| `cache.max_staleness` | Oldest source snapshot allowed while a concurrent direct refresh owns its lease. | It does not hide arbitrary provider failure: a failed central refresh returns `503`. |
| `cache.provider_timeout` | Lease lifetime used to coalesce competing refreshes. | Prevents duplicate work; it is not a cancellation timeout for provider code. Keep provider queries bounded themselves. |
| `labels.source.enabled` | Adds framework source labels to every emitted sample. | Recommended; makes shared metric names unambiguous. |
| `labels.source.app` | Name of the label for configured app/server name. | Default `bobra_app`. |
| `labels.source.worker` | Name of the Worker label. | Default `bobra_worker`. |
| `labels.source.handler` | Name of the handler label. | Default `bobra_handler`. |
| `labels.static` | Fixed labels added to every sample from this Worker. | Use only stable low-cardinality values such as `environment`; worker-level `null` removes an inherited label. |

The schema also accepts `cache.force_refresh_cooldown`, `cache.adaptive`, `cache.alarm`, and `cache.discovery`. They are validated and inherited, but the current runtime does not yet apply their additional scheduling, retry, or discovery behaviour. Do not use them as an availability/cost control yet; today `freshness`, `max_staleness`, and `provider_timeout` are the effective controls.

Example worker override:

```yaml
metrics:
  enabled: true
  internal_token_binding: "APP_METRICS_INTERNAL_TOKEN"
  labels:
    static: { environment: "production" }
workers:
  billing-worker:
    metrics:
      enabled: true
      cache: { freshness: "30s" }
      labels:
        static: { metric_domain: "billing" }
```

## Defining metrics

Add `metrics` to a handler. Return a complete current snapshot, not deltas which Bobra accumulates.

```ts
import { Hono } from 'hono';
import type { AppHandler } from '@danylohotvianskyi/bobra-framework/core';

const ordersHandler: AppHandler = {
  name: 'orders',
  version: '1.0.0',
  routes: new Hono() as AppHandler['routes'],
  metrics: {
    async collect({ env }) {
      const pending = await loadPendingOrderCount(env);
      const processed = await loadProcessedOrderCount(env);
      return [
        {
          name: 'orders_pending',
          help: 'Current number of pending orders.',
          type: 'gauge',
          samples: [{ value: pending }],
        },
        {
          name: 'orders_processed_total',
          help: 'Total number of processed orders.',
          type: 'counter',
          samples: [{ labels: { outcome: 'success' }, value: processed }],
        },
      ];
    },
  },
};
```

| Field | Requirement |
| --- | --- |
| `name` | Valid Prometheus name: letters, digits, `_`, `:`, starting with a letter, `_`, or `:`. |
| `help` | Stable human meaning. One metric name cannot have different help text across providers. |
| `type` | `counter` for a monotonic total; `gauge` for a value that rises and falls. |
| `samples` | Finite numeric values with optional string labels having valid Prometheus label names. |

Bobra rejects invalid metrics. If two providers emit the same metric name and identical label set with different values, it omits that sample rather than silently serving an untrustworthy value. Use database-side aggregation (`COUNT`, `SUM`, grouped queries), return only aggregates, and avoid high-cardinality labels: never label by request ID, token ID, email, timestamp, dynamic URL, or raw error text.

## Direct collection: simplest and freshest

To use no optimization, disable the cache on the central Worker (or globally):

```yaml
metrics:
  enabled: true
  internal_token_binding: "APP_METRICS_INTERNAL_TOKEN"
  cache: { enabled: false }
```

Every scrape concurrently calls every source Worker and every source provider runs its database work:

```text
every scrape → central Worker → all source Workers → provider DB queries
```

This is the shortest path and returns scrape-time data. It is fine for small local development, manual diagnostics, or truly trivial/infrequent metrics. It is costly for normal Cloudflare production scraping because every scrape consumes central Worker execution, source Worker subrequests/execution, and provider database reads.

## Recommended Cloudflare optimization

Keep `cache.enabled: true`. Normal scrapes read the merged Durable Object snapshot; source fan-out happens only when the snapshot expires. The DO lease coalesces concurrent refreshes, so a scraper burst does not repeat the same provider work.

```text
many scrapes → central Worker → merged DO snapshot
                         │ once per freshness window
                         └→ source Workers → provider DB queries
```

This is recommended because it bounds source computation by refresh cadence rather than scraper count, removes normal scrape-time fan-out, and centralizes one public endpoint plus one edge-auth policy. Service Binding calls are internal, but they still use Worker execution and can trigger source database reads, so caching is meaningful even though the calls are not public requests.

| Need | Starting `freshness` | Trade-off |
| --- | --- | --- |
| Dashboard business metrics | `1m`–`5m` | Lowest Worker/D1 activity; values can be this old. |
| Alerting where one minute is acceptable | `30s`–`1m` | Good usual Cloudflare balance. |
| Fast operational signal | `10s`–`30s` | More source refreshes and cost. |
| Exact scrape-time value | `cache.enabled: false` | Highest repeat cost; choose deliberately. |

These are product choices, not framework limits. Set `freshness` from the maximum acceptable data age, then measure the provider query budget before reducing it.

## Scraping and security

Route and protect only the central endpoint, such as `/api/observability/metrics`. Prometheus or VMagent should scrape that one URL through normal edge authentication. Never expose `/_bobra/metrics/collect`, never give the scraper the internal secret, and never use a user/API token for that protocol. Bobra returns `503` on failed collection rather than pretending a failed snapshot is a good one; alert on scrape failure too.
