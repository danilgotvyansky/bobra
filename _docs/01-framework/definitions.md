# Bobra Framework Definitions

## Handler

Handler is a self-contained module that encapsulates specific pieces of application logic, such as API endpoints, background processing, or middleware. You can think of them as *plugins* or *packages* that form a worker. 

For big enterprise projects we even suggest to create separate Git repositories for handlers and importing them as submodules to your *deployment monorepo*. 

Quick start in [Handlers](../02-handlers/handlers-guide.md).

## Worker

Multiple backend and frontend handler imports form a Bobra worker.

## Router

Router is a specialized worker that forwards requests to appropriate workers or external services based on path patterns and service discovery using [Service Fetch](../03-network/service-fetch.md). Router also passes relevant request information to handlers that is later used for backend logic (e.g. location-aware database routing).

## Service

Service is an external dependency that is directly integrated to the app routing through [Service Fetch](../03-network/service-fetch.md). Service can be worker-scoped, app-scoped, same Cloudflare account-scoped or completely external.

## Init Token

The Init Token is a high-privilege, one-time bootstrap token generated during the first database migration. it is used to initialize the first organization and administrative user. See [Tokens](../08-authentication/tokens.md) for details.

## Microfrontend (SPA)

A Microfrontend in Bobra is a static Single Page Application served by a specialized `SpaHandler`. It allows frontend code to be bundled or linked into a worker and served alongside API handlers. See [Routing](../03-network/routing.md) for details.

