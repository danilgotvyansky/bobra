## 1. Extend example app with:
  - [Melody Auth](https://github.com/ValueMelody/melody-auth) integration
  - Users handler (with queue example)
  - Auth handler with Melody JWKS validation.
  - Generic Hello World frontend secured by Melody Auth that authenticates to auth handler
  - Generic landing page served from the same worker.

## 2. Quickstart package script
  - Script that copies example-app from framework to your directory replacing `(?i)example.*app` with user-provided project name.

## 3. Test coverage

## 4. Self-hosted WorkerD deployment
  - Self host WorkerD and Bobra in containerized environment (e.g. K8s) configuration, charts, etc.
  - Cloudflare Queues to Redis queues adapter
  - HYPERDRIVE to Postgres adapter.
  - D1 to SQLite adapter 
