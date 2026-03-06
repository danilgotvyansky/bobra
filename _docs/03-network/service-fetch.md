# Service Fetch

`serviceFetch` is the core utility for inter-service communication in Bobra. It provides a transparent interface for calling handlers, workers, or external APIs, regardless of where they are deployed.

## The Problem

In a distributed worker environment, a service might be:
1.  **Local**: Part of the same worker (same process).
2.  **Remote**: A separate Cloudflare Worker (via Service Binding).
3.  **External**: A third-party API (via HTTP).

Writing different code for each case leads to brittle architecture. `serviceFetch` abstracts these differences away.

## Communication Cases

### 1. Internal Routing (Same Worker)
If the target handler is registered within the **current worker**, `serviceFetch` performs a direct function call (zero network latency).

```typescript
// Calling the 'users' handler from the 'teams' handler in the same worker
const response = await serviceFetch(c, 'users', '/profile/get');
```

### 2. Service Bindings (Distributed)
If the target is not local but exists as a **Cloudflare Service Binding** defined in the worker's environment, `serviceFetch` uses that binding to communicate across the Cloudflare network.

```typescript
// Uses the 'AUTH_SERVICE' binding if it exists in env
const response = await serviceFetch(c, 'auth', '/token/verify');
```

### 3. External & Router Proxying
If neither local nor binding exists, the request is forwarded to the **Router** (or a globally configured base URL). The Router then decides whether to proxy it to another worker or an external URL.

```typescript
// Falls back to global routing if 'billing' is not local or bound
const response = await serviceFetch(c, 'billing', '/invoice/generate');
```

## How to use it properly

### Always use the Context (`c`)
The first argument to `serviceFetch` should always be the Hono Context. This allows the utility to:
- Access the `env` for service discovery.
- Propagate **Trace IDs** for logging.
- Forward **Cloudflare Location** data for database routing.

### Base Path Resolution
If the service is part of your app, `serviceFetch` will handle path prefixing automatically. You should provide the relative path for the target service:

```typescript
// Correct: relative to the users service
serviceFetch(c, 'users', '/get'); 

// Incorrect: absolute paths often lead to routing errors
// serviceFetch(c, 'users', '/api/users/get'); 
```

## Propagating Context

If you need to forward the current user's authorization to a downstream service, use the optional `init` object:

```typescript
await serviceFetch(c, 'users', '/me', {
  headers: {
    'Authorization': c.req.header('Authorization')
  }
});
```
