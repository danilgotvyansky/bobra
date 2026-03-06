# Logging Guide

Bobra provides a structured logging system designed for Workers, ensuring that logs are captured efficiently and provide maximum utility during debugging.

## Logger Usage

The framework exports a standard logger that supports different log levels and automatic context attachment. Use `getLogger()` to obtain the logger instance.

```typescript
import { getLogger } from '@danylohotvianskyi/bobra-framework';

const logger = getLogger();

logger.info('Identity token created', { email: data.email, guest_name: data.guest_name });
logger.error('Error checking identity', error instanceof Error ? error : new Error(String(error)));
```

## Log Levels

Bobra supports the following standard log levels (defined numerically in `config.yml`):
- `0` (DEBUG)
- `1` (INFO)
- `2` (WARN)
- `3` (ERROR)
- `4` (SILENT)

## Initialization Verbosity

Initialization is a critical phase where handlers, databases, and services are orchestrated. To debug complex initialization sequences, you can enable specific verbosity levels in `config.yml`.

### `startupVerbosity`
Use the `startupVerbosity` array to enable detailed logging for specific framework sub-systems:

```yaml
logging:
  level: 1
  format: "json"
  startupVerbosity: 
    - 'worker-registry'
    - 'discovery-validation'
    - 'handler-add'
    - 'handler-init'
```

#### Verbosity Levels Explained:
- **`worker-registry`**: Logs the registration of the main worker app and all its associated handlers in the internal registry. Use this to verify that your worker is aware of all handlers.
- **`discovery-validation`**: Logs a summary of the service discovery process. It lists which handlers were successfully initialized and which service bindings (internal or external) were detected. Use this to debug missing bindings or service resolution issues.
- **`handler-add`**: Logs the mounting of each handler onto the worker, including its version and the relative path where it is being served. Use this to verify path routing during development.
- **`handler-init`**: Logs when a handler's asynchronous `init()` function has completed successfully. Use this to track long-running initialization logic (e.g., pre-fetching data or setting up connections).

## Logging Middleware

The `factory` automatically registers a standard logging middleware for all HTTP requests. This middleware provides a consistent **Access Log** for every request.

### Logged Fields:
The middleware extracts and logs the following fields:
- **`method`**: The HTTP request method (e.g., `GET`, `POST`).
- **`path`**: The request path. It intelligently handles proxies by checking the `X-Forwarded-Url` header.
- **`status`**: The HTTP response status code.
- **`duration`**: The total processing time in milliseconds.
- **`ip`**: The client IP address (extracted from `CF-Connecting-IP`, `X-Forwarded-For`, or `X-Real-IP`).
- **`userAgent`**: The client's User-Agent string.
- **`referer`**: The Referer header if present.

### Enhanced Logging (Optional)
You can enable additional fields in `config.yml`:
- **`logHeaders`**: Logs all request headers (automatically sanitized for sensitive keys like `Authorization` or `Cookie`).
- **`logRequestBody`**: Logs the JSON body of `POST`, `PUT`, and `PATCH` requests.
- **`logResponseBody`**: Logs the JSON response body.

> [!TIP]
> Use `logRequestBody` and `logResponseBody` with caution in production as they can impact performance and increase log storage costs.

## Tail Workers

*Coming soon...*
