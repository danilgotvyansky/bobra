import { getLogger } from '../logging/logger';
import { appWorkerRegistry } from '../core/discovery';
import {
  loadConfig,
  getWorkerBasePath,
  normalizePath,
  getServiceDiscovery,
  getFetchInstance,
  getRouterBasePath,
  getRouterWorkerName,
  type FetchInstance
} from '../core/config';
import { Context } from 'hono';
import type { RouterEnv } from './router';

// Convenience function for simple handler calls
export async function callHandler(
  // Replaced WorkerEnv with RouterEnv for consistency
  env: RouterEnv,
  handlerName: string,
  uri: string,
  options: RequestInit = {}
): Promise<Response> {
  return serviceFetch(env, handlerName, uri, options);
}

// Convenience function for simple service calls
export async function callService(
  // Replaced WorkerEnv with RouterEnv for consistency
  env: RouterEnv,
  serviceName: string,
  uri: string,
  options: RequestInit = {}
): Promise<Response> {
  return serviceFetch(env, serviceName, uri, options);
}

// Redact Authorization headers from options for debug logging
function redactOptions(options?: RequestInit): RequestInit | undefined {
  try {
    const o: RequestInit | undefined = options ? JSON.parse(JSON.stringify(options)) : undefined;
    if (o && o.headers) {
      const h = new Headers(o.headers);
      if (h.has('Authorization')) h.set('Authorization', 'Bearer ***');
      if (h.has('X-Authorization')) h.set('X-Authorization', '***');
      o.headers = Object.fromEntries(h.entries());
    }
    return o;
  } catch { return options; }
}

// Core inter-service communication utility
export async function serviceFetch(
  // Replaced any with RouterEnv - matches framework's environment interface
  env: RouterEnv,
  fetchInstance: FetchInstance | string,
  uri: string,
  options: RequestInit = {},
  // Replaced any with Hono Context - standard request context
  ctx?: Context
): Promise<Response> {
  const config = await loadConfig(env);
  const workerName = env.WORKER_NAME || 'default-worker';

  const discovery = getServiceDiscovery(env, config, workerName as string, appWorkerRegistry);
  const routerWorkerName = getRouterWorkerName(config);

  // If fetchInstance is a string, resolve it to an actual instance
  let instance: FetchInstance | null;

  if (typeof fetchInstance === 'string') {
    instance = getFetchInstance(fetchInstance, discovery, env);

    if (!instance) {
      const availableHandlers = discovery.initializedHandlers.join(', ');
      const availableServices = discovery.assignedServices.map(s => s.service).join(', ');
      const routerServices = discovery.allWorkers[routerWorkerName]?.services?.map(s => s.service).join(', ') || 'none';

      getLogger().error(`Target '${fetchInstance}' not found in worker '${workerName}'. Available handlers: [${availableHandlers}], available services: [${availableServices}], router services: [${routerServices}]`);
      throw new Error(`Target '${fetchInstance}' not found in worker '${workerName}'. Available handlers: [${availableHandlers}], available services: [${availableServices}], router services: [${routerServices}]`);
    }
  } else {
    instance = fetchInstance;
  }

  // Forward Authorization from ctx if not explicitly provided
  const ensureAuthHeader = (init?: RequestInit): RequestInit => {
    const initCopy: RequestInit = { ...init };
    const headers = new Headers(initCopy.headers || {});
    if (!headers.has('Authorization') && !headers.has('X-Authorization')) {
      try {
        const ctxHeaders = {
          get: (name: string) => ctx?.req?.header(name) || null
        };
        const authVal = ctxHeaders?.get?.('Authorization') || ctxHeaders?.get?.('X-Authorization');
        if (authVal) headers.set('Authorization', authVal);
      } catch { }
    }
    initCopy.headers = headers;
    return initCopy;
  };

  getLogger().debug(`serviceFetch: target=${instance.name}, worker=${workerName}`, {
    target: instance.name,
    type: instance.type,
    workerName,
    assignedHandlers: discovery.assignedHandlers,
    initializedHandlers: discovery.initializedHandlers,
    assignedServices: discovery.assignedServices,
    allWorkers: Object.keys(discovery.allWorkers)
  });

  getLogger().debug(`serviceFetch: found instance`, {
    target: instance.name,
    type: instance.type,
    name: instance.name,
    hasBinding: !!instance.binding,
    hasExternalUrl: !!instance.external_url
  });

  const workerBasePath = getWorkerBasePath(config, workerName as string);
  const routerBasePath = getRouterBasePath(config);

  // Case 1: Handler on same worker — use in-memory Hono app.fetch
  if (instance.type === 'handler' && discovery.initializedHandlers.includes(instance.name)) {
    const handler = appWorkerRegistry.getHandler(workerName as string, instance.name);
    if (!handler) {
      throw new Error(`Handler '${instance.name}' not found in discovery`);
    }

    const workerApp = appWorkerRegistry.getMainApp(workerName as string);
    if (!workerApp) {
      throw new Error(`Worker app '${workerName}' not found in registry`);
    }

    getLogger().debug(`serviceFetch: calling other handler in memory via main app`, {
      handlerName: instance.name,
      originalUri: uri,
      method: options.method || 'GET',
      workerName: workerName
    });

    const handlerPath = workerBasePath === '/' ? `/${instance.name}` : `${workerBasePath}/${instance.name}`;

    let fullPath: string;
    if (uri === '/' || uri === '') {
      fullPath = handlerPath;
    } else {
      const requestPath = uri.startsWith('/') ? uri : `/${uri}`;
      const normalizedRequestPath = normalizePath(requestPath);
      fullPath = `${handlerPath}${normalizedRequestPath}`;
    }

    getLogger().debug(`serviceFetch: in-memory request details`, {
      fullPath: fullPath,
      method: options.method || 'GET',
      handlerBasePath: handlerPath,
      uri: uri,
      constructionLogic: uri === '/' || uri === '' ? 'root route' : 'sub route'
    });

    try {
      if (options instanceof Request) {
        const init = ensureAuthHeader({ method: options.method, headers: options.headers, body: options.body });
        return await workerApp.request(fullPath, init, env);
      } else {
        const init = ensureAuthHeader({ method: options.method || 'GET', headers: options.headers, body: options.body });
        return await workerApp.request(fullPath, init, env);
      }
    } catch (error) {
      getLogger().error(`In-memory handler call failed`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Case 2: Service binding without external_url — use service binding direct call
  if (instance.type === 'service' && instance.binding && !instance.external_url) {
    try {
      getLogger().debug(`serviceFetch: using service binding directly`, {
        serviceName: instance.name,
        bindingName: Object.keys(env).find(key => env[key] === instance.binding),
        uri,
        options: redactOptions(options)
      });
      const init = ensureAuthHeader(options);
      const url = uri.startsWith('http') ? uri : `http://internal${uri.startsWith('/') ? uri : '/' + uri}`;
      return await (instance.binding as { fetch: (url: string, init?: RequestInit) => Promise<Response> }).fetch(url, init);
    } catch (error) {
      getLogger().error(`Direct service binding call failed for ${instance.name}`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Case 3: Service binding with external_url — direct fetch
  if (instance.type === 'service' && instance.external_url) {
    getLogger().debug(`serviceFetch: using external_url`, {
      external_url: instance.external_url,
      uri,
      options: redactOptions(options)
    });
    const baseUrl = instance.external_url.endsWith('/')
      ? instance.external_url
      : `${instance.external_url}/`;
    const relativeUri = uri.startsWith('/') ? uri.slice(1) : uri;
    const url = new URL(relativeUri, baseUrl);
    const init = ensureAuthHeader(options);
    return await fetch(url.toString(), init);
  }

  // Case 4: Handler on other worker — route through router
  if (instance.type === 'handler') {
    const routerService = discovery.assignedServices.find(s => s.service === routerWorkerName);
    if (!routerService) {
      throw new Error('Router service binding not found for inter-worker handler calls');
    }

    const routerBinding = env[routerService.binding];
    if (!routerBinding && !routerService.external_url) {
      throw new Error('Router service binding not available');
    }

    // Find which worker hosts this handler
    let targetWorker: string | null = null;
    for (const [wn, worker] of Object.entries(discovery.allWorkers)) {
      if (worker.handlers.includes(instance.name)) {
        targetWorker = wn;
        break;
      }
    }

    if (!targetWorker) {
      throw new Error(`Handler '${instance.name}' not found in any worker configuration`);
    }

    const targetWorkerBasePath = getWorkerBasePath(config, targetWorker);
    const routerPath = `${targetWorkerBasePath}/${instance.name}${uri.startsWith('/') ? uri : '/' + uri}`;

    if (routerService.external_url) {
      getLogger().debug(`serviceFetch: using external_url to router for handler`, {
        external_url: routerService.external_url,
        routerPath,
        targetWorker,
        handlerName: instance.name,
        options: redactOptions(options)
      });
      const url = new URL(routerPath, routerService.external_url);
      const init = ensureAuthHeader(options);
      return await fetch(url.toString(), init);
    } else {
      getLogger().debug(`serviceFetch: using service binding to router for handler`, {
        binding: routerService.binding,
        routerPath,
        targetWorker,
        handlerName: instance.name,
        options: redactOptions(options)
      });
      const init = ensureAuthHeader(options);
      const url = routerPath.startsWith('http') ? routerPath : `http://internal${routerPath.startsWith('/') ? routerPath : '/' + routerPath}`;
      return await (routerBinding as { fetch: (url: string, init?: RequestInit) => Promise<Response> }).fetch(url, init);
    }
  }

  // Case 5: Service on router (for non-router workers) — route through router with service proxying
  if (instance.type === 'service' && !instance.binding) {
    const routerService = discovery.assignedServices.find(s => s.service === routerWorkerName);

    if (!routerService) {
      throw new Error('Router service binding not found for service calls');
    }

    const routerBinding = env[routerService.binding];
    if (!routerBinding && !routerService.external_url) {
      throw new Error('Router service binding not available');
    }

    let serviceProxyPath: string;
    if (uri === '/' || uri === '') {
      serviceProxyPath = `/router/services/${instance.name}`;
    } else {
      const normalizedUri = uri.startsWith('/') ? uri : '/' + uri;
      serviceProxyPath = `/router/services/${instance.name}${normalizedUri}`;
    }

    if (routerService.external_url) {
      getLogger().debug(`serviceFetch: using external_url to router for service proxy`, {
        external_url: routerService.external_url,
        serviceProxyPath,
        serviceName: instance.name,
        options: redactOptions(options)
      });
      const url = new URL(serviceProxyPath, routerService.external_url);
      const init = ensureAuthHeader(options);
      return await fetch(url.toString(), init);
    } else {
      getLogger().debug(`serviceFetch: using service binding to router for service proxy`, {
        binding: routerService.binding,
        serviceProxyPath,
        serviceName: instance.name,
        options: redactOptions(options)
      });
      const init = ensureAuthHeader(options);
      const url = serviceProxyPath.startsWith('http') ? serviceProxyPath : `http://internal${serviceProxyPath.startsWith('/') ? serviceProxyPath : '/' + serviceProxyPath}`;
      return await (routerBinding as { fetch: (url: string, init?: RequestInit) => Promise<Response> }).fetch(url, init);
    }
  }

  throw new Error(`Unsupported fetch instance type: ${instance.type} for target: ${instance.name}`);
}
