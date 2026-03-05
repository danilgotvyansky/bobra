# Deployment Guide

Bobra supports flexible deployment models, ranging from a single "Monolithic" worker to a highly distributed microservices architecture.

## Deployment Models

### 1. Monolithic Deployment
In a monolithic setup, multiple handlers (e.g., users, teams, alerting) are bundled into a single Cloudflare Worker. This is ideal for smaller projects or early-stage development to reduce complexity.

### 2. Microservices Deployment
In a distributed setup, handlers would be deployed to multiple Workers. They communicate via **Service Bindings**. This allows better fault isolation and clear logical ownership.

## The Monolithic Restriction

Even when using a "Monolithic" deployment model, there are certain components that **must** be deployed as separate workers due to platform-level requirements or architectural constraints.

### The Router Worker
The **Router** acts as the global ingress point. It manages global CORS and request routing to your Workers. Because it needs to orchestrate between different bindings and external URLs, it must remain standalone.

### The Tail Worker
**Tail Workers** are designed to observe and capture logs from other workers. Due to a workerd runtime restriction, tail workers cannot have other triggers.

> [!IMPORTANT]
> A "Monolithic Bobra deployment" typically consists of at least three workers:
> 1.  **The Industrial Worker** (Monolith): Contains all business logic handlers.
> 2.  **The Router Worker**: For global ingress and routing.
> 3.  **The Tail Worker**: For logging and observability.

## Configuration Injection

During deployment, ensure that all necessary environment variables (e.g., `DB_CONNECTION_STRING`) are correctly set in the Cloudflare dashboard or via `wrangler.jsonc` secrets. Bobra's `factory` will validate these against your `config.yml` on startup.

## Microfrontends

Bobra provides first-class support for serving static assets and Single-Page Applications (SPAs) directly from Workers or the Router using the `assets` configuration.

### Configuration Structure

Assets are defined within the `router` or individual `workers` blocks in `config.yml`.

```yaml
# Example: Router serving the Main App (SPA)
router:
  assets:
    directory: "dist"
    binding: "ASSETS"
    not_found_handling: "single-page-application" # Enables SPA fallback to index.html

# Example: Worker serving a Supporting App (Manual assets)
workers:
  main-worker:
    assets:
      directory: "dist"
      binding: "ASSETS"
      not_found_handling: "none" # Direct static serving
```

### Deployment Roles

1.  **Main App (Router)**: The Router typically serves the main dashboard or portal. By setting `not_found_handling: "single-page-application"`, it ensures that all non-API requests fall back to `index.html`, allowing the frontend router to take over.
2.  **Supporting Apps (Workers)**: Specialized frontends (e.g. "Admin Console") can be hosted on separate Workers. These are usually served under a specific sub-path (e.g., `/admin`) routed by the global Router.

### Asset Serving Logic
- **`directory`**: The local path to your build artifacts (e.g., `dist`).
- **`binding`**: The name of the asset binding (usually `ASSETS`).
- **`not_found_handling`**:
    - `single-page-application`: Automatically serves `index.html` for 404s.
    - `none`: Standard static file serving.
 This separation allows you to:
1.  **Version Frontends Independently**: Update a frontend worker without affecting the main API.
2.  **Centralize Auth**: The `router` can check for authentication before even reaching the asset-serving worker.
3.  **Optimize Performance**: Use Cloudflare's edge caching for static assets while keeping your API dynamic.
