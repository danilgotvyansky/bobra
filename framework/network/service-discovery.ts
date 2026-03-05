import type { MiddlewareHandler } from 'hono';
import { getLogger } from '../logging/logger';
import { getServiceDiscovery, type AppConfig } from '../core/config';
import { appWorkerRegistry } from '../core/discovery';
import { Context, Next } from 'hono';

/**
 * Middleware that validates service discovery configuration on each request.
 * Logs warnings when config doesn't match available bindings/handlers.
 */
export function serviceDiscoveryMiddleware(
  env: any,
  config: AppConfig,
  workerName: string
): MiddlewareHandler {
  // Flag to ensure we log a mismatch warning only once per worker lifecycle, preventing log spam on every request
  let warnedAboutMismatch = false;

  return async (c: Context, next: Next) => {
    // Compute discovery on every request so handlers always have fresh context
    const discovery = getServiceDiscovery(env, config, workerName, appWorkerRegistry);

    // Store in Hono context so handlers can access it via c.get('serviceDiscovery')
    c.set('serviceDiscovery', discovery);

    // Only warn once per worker lifecycle to avoid log spam
    if (!warnedAboutMismatch && !discovery.configMatchesReality) {
      const logger = getLogger();
      logger.warn('Service discovery mismatch detected', {
        worker: workerName,
        assigned: discovery.assignedHandlers,
        initialized: discovery.initializedHandlers,
        services: discovery.assignedServices.map(s => s.service)
      });
      warnedAboutMismatch = true;
    }

    await next();
  };
}
