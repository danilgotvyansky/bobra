import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppConfig, RouteConfig } from '../core/config';
import {
  getRouterBasePath,
  getWorkerBasePath,
  serviceToBindingName,
  normalizePath,
  loadConfig
} from '../core/config';
import { getLogger, initializeLogger, type LoggerConfig } from '../logging/logger';
import { simpleHonoLogger } from '../logging/logging-middleware';

export interface RouterEnv {
  CONFIG_CONTENT?: string;
  [key: string]: any;
}

export function getServicesFromRoutes(routes: RouteConfig[]): string[] {
  const services = new Set<string>();
  routes.forEach(route => services.add(route.service));
  return Array.from(services);
}

export function findMatchingRoute(path: string, routes: RouteConfig[]): RouteConfig | null {
  for (const route of routes) {
    const routePattern = route.path.replace(/\*/g, '.*');
    const regex = new RegExp(`^${routePattern}$`);
    if (regex.test(path)) {
      return route;
    }
  }
  return null;
}

export function getServiceBinding(serviceName: string, env: RouterEnv): any {
  const bindingName = serviceToBindingName(serviceName);
  const binding = env[bindingName];

  if (!binding) {
    getLogger().error(`Service binding not found: ${bindingName} for service ${serviceName}`);
    getLogger().info('Available bindings:', Object.keys(env).filter(key => key.endsWith('_WORKER') || key.endsWith('_SERVICE')));
  }

  return binding;
}

/**
 * Forward a request to a router-hosted service (external URL or binding).
 * `workerName` is injected into `X-Forwarded-By` for tracing.
 */
export async function handleServiceProxy(
  c: any,
  config: AppConfig,
  serviceName: string,
  remainingPath: string,
  workerName: string
): Promise<Response> {
  if (!config.router?.services) {
    return c.json({
      success: false,
      error: 'No router services configured',
      service: serviceName
    }, 404);
  }

  const serviceConfig = config.router.services.find((s: any) => s.service === serviceName);
  if (!serviceConfig) {
    return c.json({
      success: false,
      error: 'Service not found in router configuration',
      service: serviceName,
      available_services: config.router.services.map((s: any) => s.service)
    }, 404);
  }

  try {
    let response: Response;
    const originalUrl = new URL(c.req.url);

    if (serviceConfig.external_url) {
      const targetPath = remainingPath || '/';
      const targetUrl = new URL(targetPath, serviceConfig.external_url);
      targetUrl.search = originalUrl.search;

      getLogger().info(`🔀 Router proxying ${c.req.method} /router/services/${serviceName}${remainingPath}${originalUrl.search} → ${targetUrl.toString()}`);

      const newHeaders = new Headers(c.req.raw.headers);
      newHeaders.set('X-Forwarded-By', workerName);
      newHeaders.set('X-Original-Path', c.req.path);
      // Forward CF location data for pgEdge geo-routing
      const cf = (c.req.raw as any).cf;
      if (cf?.continent) newHeaders.set('X-CF-Continent', cf.continent);
      if (cf?.colo) newHeaders.set('X-CF-Colo', cf.colo);

      response = await fetch(targetUrl.toString(), {
        method: c.req.method,
        headers: newHeaders,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? await c.req.text() : undefined
      });
    } else {
      const serviceBinding = c.env[serviceConfig.binding];
      if (!serviceBinding) {
        return c.json({
          success: false,
          error: 'Service binding not available',
          service: serviceName,
          expected_binding: serviceConfig.binding,
          hint: `Make sure ${serviceConfig.binding} service binding is configured in wrangler.jsonc`
        }, 503);
      }

      getLogger().info(`🔀 Router proxying ${c.req.method} /router/services/${serviceName}${remainingPath}${originalUrl.search} → service binding ${serviceConfig.binding}`);

      const forwardPath = remainingPath || '/';

      const newHeaders = new Headers(c.req.raw.headers);
      newHeaders.set('X-Forwarded-By', workerName);
      newHeaders.set('X-Original-Path', c.req.path);

      // Service bindings expect relative paths, so we construct a dummy URL
      const serviceUrl = new URL(forwardPath, 'http://localhost');
      serviceUrl.search = originalUrl.search;
      const newRequest = new Request(serviceUrl.toString(), {
        method: c.req.method,
        headers: newHeaders,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? await c.req.text() : undefined
      });

      response = await serviceBinding.fetch(newRequest);
    }

    return response;

  } catch (error) {
    getLogger().error(`❌ Error proxying to service ${serviceName}:`, error instanceof Error ? error : new Error(String(error)));
    return c.json({
      success: false,
      error: 'Service proxy error',
      service: serviceName,
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

export interface CreateRouterAppOptions {
  workerName: string;
  /**
   * Optional hook called after logging+CORS are registered but before
   * built-in routes. Use it to add custom auth middleware, etc.
   */
  onBeforeRoutes?: (app: Hono<{ Bindings: RouterEnv }>, config: AppConfig) => void;
  /**
   * Optional hook to build the public config response object.
   * If omitted, a default response with router basePath + workers is returned.
   */
  buildPublicConfig?: (config: AppConfig, env: RouterEnv) => Record<string, any>;
}

/**
 * Create a Hono router app populated with standard routes:
 * health, public config, service proxy, and catch-all route forwarding.
 */
export function createRouterApp(
  config: AppConfig,
  options: CreateRouterAppOptions,
  loggingConfig?: LoggerConfig
): Hono<{ Bindings: RouterEnv }> {
  const routerBasePath = getRouterBasePath(config);
  const { workerName } = options;

  const app = routerBasePath === '/'
    ? new Hono<{ Bindings: RouterEnv }>()
    : new Hono<{ Bindings: RouterEnv }>().basePath(routerBasePath);

  app.use('*', simpleHonoLogger(loggingConfig));

  app.use('*', cors({
    origin: config.cors.origin,
    allowMethods: config.cors.allowMethods,
    allowHeaders: config.cors.allowHeaders,
  }));

  // Allow consumers to register custom middleware (auth, etc.)
  if (options.onBeforeRoutes) {
    options.onBeforeRoutes(app, config);
  }

  app.get('/router/config/public', (c) => {
    try {
      const env = c.env as RouterEnv;
      const basePath = getRouterBasePath(config);
      const workers = Object.entries(config.workers || {}).map(([name, worker]) => ({
        name,
        basePath: getWorkerBasePath(config, name),
        handlers: worker.handlers || []
      }));

      if (options.buildPublicConfig) {
        return c.json({ success: true, ...options.buildPublicConfig(config, env) });
      }

      return c.json({
        success: true,
        router: { basePath },
        workers,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLogger().error('❌ Failed to build public config:', err);
      return c.json({ success: false, error: 'Failed to build public config' }, 500);
    }
  });

  app.get('/router/health', (c) => {
    if (!config.router) {
      return c.json({ status: 'error', message: 'Router config not found' }, 500);
    }

    try {
      const services = getServicesFromRoutes(config.router.routes);

      return c.json({
        status: 'healthy',
        service: workerName,
        timestamp: new Date().toISOString(),
        config: {
          name: config.router.name,
          description: config.router.description,
          basePath: routerBasePath,
          routes_count: config.router.routes.length,
          services: services
        },
        routes: config.router.routes.map(r => ({
          path: r.path,
          service: r.service,
          binding: serviceToBindingName(r.service),
          workerBasePath: getWorkerBasePath(config, r.service)
        })),
        router_services: config.router.services?.map(s => ({
          binding: s.binding,
          service: s.service,
          external_url: s.external_url
        })) || []
      });
    } catch (error) {
      return c.json({
        status: 'error',
        service: workerName,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Configuration error'
      }, 500);
    }
  });

  app.all('/router/services/:serviceName/*', async (c) => {
    getLogger().debug('🎯 Service proxy route with wildcard matched!');

    const serviceName = c.req.param('serviceName');

    const url = new URL(c.req.url);
    const expectedPrefix = `/router/services/${serviceName}`;
    let remainingPath = url.pathname.slice(expectedPrefix.length);

    if (!remainingPath.startsWith('/')) {
      remainingPath = '/' + remainingPath;
    }
    if (remainingPath === '/') {
      remainingPath = '';
    }

    return await handleServiceProxy(c, config, serviceName, remainingPath, workerName);
  });

  app.all('/router/services/:serviceName', async (c) => {
    const serviceName = c.req.param('serviceName');
    return await handleServiceProxy(c, config, serviceName, '', workerName);
  });

  app.all('*', async (c) => {
    if (!config.router) {
      return c.json({ status: 'error', message: 'Router config not found' }, 500);
    }

    try {
      const url = new URL(c.req.url);
      const fullPath = url.pathname;
      const pathWithQuery = `${url.pathname}${url.search}`;

      if (fullPath.startsWith('/router/services/')) {
        getLogger().warn(`🚨 Service proxy request not caught by routes: ${pathWithQuery}`);
        return c.json({
          success: false,
          error: 'Service proxy route not matched',
          path: pathWithQuery,
          hint: 'This service proxy request was not caught by the service proxy routes'
        }, 404);
      }

      const relativePath = routerBasePath === '/'
        ? fullPath
        : fullPath.startsWith(routerBasePath)
          ? fullPath.slice(routerBasePath.length) || '/'
          : fullPath;

      const normalizedRelativePath = normalizePath(relativePath);

      getLogger().debug(`🔍 Router processing: ${pathWithQuery} (relative: ${relativePath}, normalized: ${normalizedRelativePath})`);
      const route = findMatchingRoute(normalizedRelativePath, config.router.routes);

      if (!route) {
        return c.json({
          success: false,
          error: 'Route not found',
          path: pathWithQuery,
          relativePath: relativePath,
          normalizedRelativePath: normalizedRelativePath,
          routerBasePath: routerBasePath,
          available_routes: config.router.routes.map(r => r.path)
        }, 404);
      }

      const service = getServiceBinding(route.service, c.env);

      if (!service) {
        const bindingName = serviceToBindingName(route.service);
        return c.json({
          success: false,
          error: 'Service not available',
          service: route.service,
          expected_binding: bindingName,
          path: pathWithQuery,
          hint: `Make sure ${bindingName} service binding is configured in wrangler.jsonc`
        }, 503);
      }

      const workerBasePath = getWorkerBasePath(config, route.service);
      const forwardPath = normalizedRelativePath;

      const forwardUrl = new URL(c.req.url);
      forwardUrl.pathname = forwardPath;

      getLogger().info(`🔀 Forwarding ${c.req.method} ${pathWithQuery} → ${forwardPath} to ${route.service} (${serviceToBindingName(route.service)}) (worker basePath: ${workerBasePath})`);

      const newHeaders = new Headers(c.req.raw.headers);
      newHeaders.set('X-Forwarded-Url', c.req.url);
      // Forward CF location data for pgEdge geo-routing
      const cf = (c.req.raw as any).cf;
      if (cf?.continent) newHeaders.set('X-CF-Continent', cf.continent);
      if (cf?.colo) newHeaders.set('X-CF-Colo', cf.colo);
      const orgUid = c.req.query('org_uid');
      if (orgUid) {
        newHeaders.set('X-Org-Context', orgUid);
      }

      const newRequest = new Request(forwardUrl.toString(), {
        method: c.req.method,
        headers: newHeaders,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? await c.req.text() : undefined
      });

      const response = await service.fetch(newRequest);
      return response;

    } catch (error) {
      getLogger().error(`❌ Error in router:`, error instanceof Error ? error : new Error(String(error)));
      return c.json({
        success: false,
        error: 'Router error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  return app;
}

/**
 * Create a standard Cloudflare Workers `fetch` handler for a router worker.
 * Handles config loading, logger init, and delegates to `createRouterApp`.
 */
export function createRouterWorker(options: CreateRouterAppOptions) {
  return {
    async fetch(request: Request, env: RouterEnv, ctx: any): Promise<Response> {
      try {
        const config = await loadConfig(env);

        if (!config.router) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Router configuration is missing from config.yml'
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const routerLoggingConfig = {
          ...config.logging,
          ...config.router.logging
        };
        initializeLogger(routerLoggingConfig, 'router', options.workerName);

        const app = createRouterApp(config, options, routerLoggingConfig as LoggerConfig);

        return app.fetch(request, env, ctx);
      } catch (error) {
        getLogger().error('❌ Router initialization error:', error instanceof Error ? error : new Error(String(error)));
        return new Response(JSON.stringify({
          success: false,
          error: 'Router initialization failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  };
}
