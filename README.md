# Bobra Framework

Bobra is a full-stack TypeScript, *batteries-included* framework for building modular nanoservices on top of Cloudflare's Workerd runtime and Hono.

## What's included?

- **Modular Handler-Based Design**: Handlers are self-contained modules that encapsulate specific pieces of application logic, such as API endpoints, background processing, or middleware. You can think of them as *plugins* or *packages* that form a worker. Read more in [Handlers](_docs/02-handlers/handlers-guide.md).
- **Worker/Service Separation**: Workers are runtime units that execute handlers. Services are any external dependencies directly integrated to the app routing.
- **Globally distributed databases**: Bobra provides an included custom database integration with support of Postgres and [D1](https://developers.cloudflare.com/d1/). To leverage global distribution and amazing Postgres features Bobra uses location-aware routing to your hosted [pgEdge](https://www.pgedge.com/) Postgres databases. Read more in [Database](_docs/05-database/database.md).
- **Deployment style variety**: This setup allows you to deploy your application both in *Monolithic* and *Microservices* styles. Read more in [Deployment](_docs/07-deployment/deployment.md).
- **Microfrontends**: Configuration wrapper around Workerd assets handling allows you to serve as many frontend applications as you want in a single worker. Read more in [Microfrontends](_docs/07-deployment/deployment.md#microfrontends).
- **Event-Driven Processing with Hono**: Bobra uses [Hono](https://hono.dev/) as its HTTP framework, providing a fast, lightweight, and extensible foundation for web applications based on Web Standards.
- **Router Worker**: A centralized routing component that forwards requests to appropriate workers or external services based on path patterns and service discovery. Read more in [Routing](_docs/03-network/routing.md) and [Service Fetch](_docs/03-network/service-fetch.md).
- **Service Discovery**: Automatic detection and registration of services, enabling dynamic load balancing and failover. 
- **Bindings Abstraction**: Unified interface for accessing external resources (databases, queues, KV stores) regardless of the underlying implementation. 
- **Configuration-Driven Architecture**: Declarative YAML configuration that defines workers, services, and their relationships providing a **single source of truth for your app** that consists of multiple workers and dependencies sharing the same infrastructure. Read more in [Config](_docs/04-config/config-guide.md)
- **Flexible and customizable logging**: Bobra provides a powerful logger that supports JSON and text formats, initialization verbosity control, log levels, Request and Response body sanitized logging, etc. Read more in [Logging](_docs/06-logging/logging.md). 
- **Authentication**: Bobra provides an included API token based authentication middleware and CRUD operations for managing API tokens. Read more in [Authentication](_docs/08-authentication/tokens.md).
- **OpenAPI**: Bobra provides an included OpenAPI generation and validation middleware. Each handler receives its own automatically generated `/openapi` endpoint out-of-the-box and a separate `api-docs-handler` that aggregates all OpenAPI specs from all handlers into a single application OpenAPI spec. Read more in [OpenAPI](_docs/09-openapi/openapi.md).
- **Search**: Bobra provides an included search implementation based on FTS5 extension for D1 (SQLite) or Postgres built-in full-text search. Read more in [Search](_docs/10-search/search-technical.md).


## Directory structure

Example directory structure for Bobra-powered application:

<details>
<summary>Directory structure</summary>

```
my-app/
.
├── config.local-example.yml
├── config.local.yml                            # excluded from vcs 
├── config.yml
├── frontends
│   ├── main-app
│   |    ├── package.json
│   |    ├── src
│   |    │   └── ...
│   |    └── tsconfig.json
│   └── landing-app
│        └── ...
├── handlers
│   ├── auth-handler
│   |    ├── package.json
│   |    ├── src
│   |    │   ├── db.ts                          # Database functions
│   |    │   ├── index.ts                       # Handler entry point
│   |    │   ├── schemas.ts                     # OpenAPI schemas
│   |    │   ├── service.ts                     # Service functions
│   |    │   └── types.ts                       # Types
│   |    └── tsconfig.json
│   ├── api-docs-handler
│   |    └── ...
│   └── users-handler
│        └── ...
├── package.json
├── router
│   └── router-worker
│       ├── package.json
│       ├── src
│       │   └── index.ts
│       ├── tsconfig.json
│       └── wrangler.jsonc
├── scripts
│   └── generate-wrangler-config.ts
├── shared-utils
│   ├── drizzle.config.ts
│   ├── package.json
│   ├── src
│   │   ├── db
│   │   │   ├── index.ts
│   │   │   ├── migrate.ts
│   │   │   ├── migrations-sqlite
│   │   │   │   ├── 0000_foamy_tusk.sql
│   │   │   │   └── meta
│   │   |   └── schema.ts
│   │   └── openapi
│   │       └── schemas.ts                       # App-level shared OpenAPI schemas
│   └── tsconfig.json
└── workers
    ├── api-docs-worker
    │   └── ...
    └── main-worker
        ├── package.json
        ├── src
        │   └── index.ts
        ├── tsconfig.json
        ├── wrangler.production.jsonc            # generated from config.yml      
        └── wrangler.jsonc                       # generated from config.local.yml
```

</details>

## [Documentation](_docs)

## Installation

Quickstart command has not been implemented yet. Please copy the [example app](example-app/) to get started with the framework.

```bash
pnpm add -w @bobra/framework
```

## [Roadmap](_docs/roadmap.md)

## [CONTRIBUTING](CONTRIBUTING.md)

## License

This project is licensed under the terms of the Apache 2.0 license.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for more information.

## Disclaimer

Danylo Hotvianskyi - the author of the project doesn't claim the ownership or copyright to any mentioned dependencies such as Hono, Drizzle ORM, Melody Auth, pgEdge, workerd, etc. All rights belong to their respective owners. 
