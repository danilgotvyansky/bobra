# Router Proxying

The Bobra Router acts as the global ingress and intelligent proxy for your application. It manages global CORS and request routing between different workers and external services.

By convention, Router is the only worker actually exposed with worker routes. All other workers can be accessed through Service Bindings only.

## Global Ingress

The primary role of the Router is to receive incoming traffic and decide which industrial worker or service should handle it based on the URL path.

```yaml
router:
  name: 'main-router'
  routes:
    - path: '/api/users*'
      service: 'users-worker'
    - path: '/api/teams*'
      service: 'teams-worker'
```

## Service Configuration

Services are defined in the `router` configuration and can be resolved in three ways:

### 1. Worker Bindings (Recommended)
Proxying to another Cloudflare Worker within the same account using Service Bindings.

```yaml
router:
  routes:
    - path: '/api/auth*'
      binding: AUTH_SERVICE # Resolves via CF Service Binding
```

### 2. External URLs
Routing requests to a completely external URL. This is useful for third-party integrations.

```yaml
router:
  routes:
    - path: '/v1/legacy*'
      binding: LEGACY_API
      external_url: 'https://legacy-api.example.com'
```

### 3. Static Assets (Microfrontends)
Routing to a frontend binding. See [Deployment](../07-deployment/deployment.md) for microfrontend configuration.

## Header Management

The Router automatically handles critical header operations:
- **CORS**: Injects CORS headers based on the `routing.cors` configuration.
- **Trace Propagation**: Injects and forwards trace IDs for observability.
- **Location Context**: Forwards Cloudflare location data (`X-CF-Colo`, `X-CF-Continent`) to downstream workers for geo-aware database routing.

## Global Middleware

You can register global middleware on the Router that applies to ALL proxied requests, such as global rate limiting or security headers.

```typescript
const router = createRouter({
  // ... config
})
  .use('*', globalSecurityHeaders())
  .export();
```

> [!TIP]
> See [example-app-router-worker](../../example-app/router/example-app-router-worker/src/index.ts) to check how default router capabilities can be extended
