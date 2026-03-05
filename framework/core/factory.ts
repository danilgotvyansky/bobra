import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { appWorkerRegistry, type AppHandler } from './discovery';
import { initializeLogger, getLogger, LogStack, LogLevel } from '../logging/logger';
import { simpleHonoLogger } from '../logging/logging-middleware';
import {
  loadConfig,
  validateConfig,
  type AppConfig,
  getWorkerBasePath,
  normalizePath,
  getWorkerLoggingConfig,
  getWorkerCorsConfig,
  getRouterBasePath,
  getWorkerQueueBindings,
  getServiceDiscovery,
} from './config';
import { serviceDiscoveryMiddleware } from '../network/service-discovery';
import { openAPISpecs } from 'hono-openapi';

// Worker environment interface
export interface WorkerEnv {
  CONFIG_CONTENT?: string;
  WORKER_NAME?: string;
  [key: string]: any;
}

// Create a new worker instance with common middleware
export async function createWorker(env?: WorkerEnv): Promise<AppWorker> {
  const app = new Hono<{ Bindings: WorkerEnv }>();

  const config = await loadConfig(env || {});
  validateConfig(config);

  const workerName = env?.WORKER_NAME || 'default-worker';
  const basePath = normalizePath(getWorkerBasePath(config, workerName));

  // Initialize logger with worker-specific configuration
  const loggingConfig = getWorkerLoggingConfig(config, workerName);
  initializeLogger(loggingConfig, 'worker', workerName);

  app.use('*', serviceDiscoveryMiddleware(env || {}, config, workerName));
  app.use('*', simpleHonoLogger(loggingConfig));

  const corsConfig = getWorkerCorsConfig(config, workerName);
  app.use('*', cors({
    origin: corsConfig.origin,
    allowMethods: corsConfig.allowMethods,
    allowHeaders: corsConfig.allowHeaders,
  }));

  // Health check endpoint (always at root level)
  app.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      server: {
        name: config.server.name,
        version: config.server.version,
        description: config.server.description
      },
      worker: {
        name: workerName,
        basePath: basePath
      },
      handlers: appWorkerRegistry.getHandlerNames(workerName).map(name => ({ name }))
    });
  });

  // Worker-level OpenAPI with router base path prefixing
  app.get('/openapi', (() => {
    const specApp = new Hono<{ Bindings: WorkerEnv }>();
    const routerBase = getRouterBasePath(config);
    // Mount the worker app under router base path so generated paths include router base
    specApp.route(routerBase === '/' ? '/' : routerBase, app);
    return openAPISpecs(specApp, {
      documentation: {
        info: {
          title: config.server.name,
          version: config.server.version,
          description: config.server.description,
        },
      },
    });
  })());

  return new AppWorker(app, config, workerName, basePath);
}

// Core worker class that manages handlers and their lifecycle
export class AppWorker {
  private app: Hono<{ Bindings: WorkerEnv }>;
  private handlers: AppHandler[] = [];
  private config: AppConfig;
  private workerName: string;
  private basePath: string;
  private initialized = false;
  private startupStack = new LogStack();

  constructor(app: Hono<{ Bindings: WorkerEnv }>, config: AppConfig, workerName: string, basePath: string) {
    this.app = app;
    this.config = config;
    this.workerName = workerName;
    this.basePath = basePath;

    // Register this worker's main app in the unified registry
    appWorkerRegistry.registerMainApp(workerName, app);

    const workerLoggingConfig = getWorkerLoggingConfig(this.config, this.workerName);
    const verbosity = workerLoggingConfig.startupVerbosity || ['worker-registry', 'discovery-validation', 'handler-add', 'handler-init'];

    if (verbosity.includes('worker-registry')) {
      this.startupStack.add(`AppWorkerRegistry registered:`, {
        worker: workerName,
        app: 'main',
        type: 'main'
      });
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getWorkerName(): string {
    return this.workerName;
  }

  getBasePath(): string {
    return this.basePath;
  }

  // Cloudflare Workers export a single queue() per worker, but a worker can consume multiple queues.
  // This dispatcher routes each batch to the correct handler based on batch.queue.
  getQueueFunction(): ((batch: any, env: WorkerEnv, ctx: any) => Promise<void>) | undefined {
    const queueHandlers = this.handlers.filter(h => typeof h.queue === 'function');

    if (queueHandlers.length === 0) {
      return undefined;
    }

    // Build routing table using optional handlesQueue(match) predicate
    const handlersWithMatchers = queueHandlers.filter(h => typeof h.handlesQueue === 'function');

    if (queueHandlers.length > 1 && handlersWithMatchers.length === 0) {
      // Backward-compat: if multiple handlers expose queue() but none declare handlesQueue,
      // warn and fall back to first handler
      getLogger().warn(`Multiple handlers with queue() found but none declare handlesQueue(). Using first one: ${queueHandlers[0]!.name}`);
    }

    return async (batch: any, env: WorkerEnv, ctx: any) => {
      await this.initialize(env);

      // Build configured queue name list from config for this worker
      let configuredQueues: string[] = [];
      try {
        const bindings = getWorkerQueueBindings(this.config, this.workerName) || {} as any;
        const consumers = bindings.consumers ?? [];
        configuredQueues = consumers.map((c: any) => c?.queue).filter(Boolean) as string[];
      } catch { }

      // Try matcher-based dispatch
      if (handlersWithMatchers.length > 0 && typeof batch?.queue === 'string') {
        const matchingHandlers = handlersWithMatchers.filter(h => {
          try { return !!h.handlesQueue!(batch.queue, configuredQueues); } catch { return false; }
        });

        if (matchingHandlers.length === 1) {
          const logger = getLogger();
          const matched = matchingHandlers[0];
          try {
            logger.setHandler?.(matched!.name);
            return await matched!.queue!(batch, env, ctx);
          } finally {
            logger.setHandler?.('');
          }
        }

        if (matchingHandlers.length > 1) {
          // If multiple match, run sequentially and aggregate errors
          getLogger().warn(`Queue '${batch.queue}' matched multiple handlers: ${matchingHandlers.map(h => h.name).join(', ')}. Executing sequentially.`);
          const errors: Error[] = [];
          for (const handler of matchingHandlers) {
            try {
              const logger = getLogger();
              try {
                logger.setHandler?.(handler.name);
                await handler.queue!(batch, env, ctx);
              } finally {
                logger.setHandler?.('');
              }
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              errors.push(e);
              getLogger().error(`Queue processing error in handler ${handler.name}`, e);
            }
          }
          if (errors.length > 0) {
            throw new Error(`One or more handlers failed for queue '${batch.queue}': ${errors.map(e => e.message).join('; ')}`);
          }
          return;
        }
      }

      // No matcher or none matched: fall back to first queue handler
      const fallback = queueHandlers[0];
      if (handlersWithMatchers.length > 0) {
        getLogger().warn(`No handler declared for queue '${batch?.queue}'. Falling back to '${fallback!.name}'.`);
      }
      try {
        const logger = getLogger();
        try {
          logger.setHandler?.(fallback!.name);
          await fallback!.queue!(batch, env, ctx);
        } finally {
          logger.setHandler?.('');
        }
      } catch (error) {
        getLogger().error(`Queue processing error in handler ${fallback!.name}`, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    };
  }

  // Add a handler to the worker
  async add(handlerModule: Promise<{ default: AppHandler }> | { default: AppHandler }): Promise<this> {
    try {
      const module = await handlerModule;
      const handler = module.default;

      // Initialize handler's logger with worker's configuration
      const loggingConfig = getWorkerLoggingConfig(this.config, this.workerName);

      if (typeof handler.initLogger === 'function') {
        handler.initLogger(loggingConfig, 'handler', this.workerName, handler.name);
      }

      // Register handler in discovery
      appWorkerRegistry.registerHandler(this.workerName, handler);

      const workerLoggingConfig = getWorkerLoggingConfig(this.config, this.workerName);
      const verbosity = workerLoggingConfig.startupVerbosity || ['worker-registry', 'discovery-validation', 'handler-add', 'handler-init'];

      if (verbosity.includes('worker-registry')) {
        this.startupStack.add(`AppWorkerRegistry registered:`, {
          worker: this.workerName,
          handler: handler.name,
          type: 'handler'
        });
      }
      this.handlers.push(handler);

      // Mount handler OpenAPI BEFORE mounting the handler to avoid /:param catching openapi
      let handlerPath = this.basePath === '/' ? `/${handler.name}` : `${this.basePath}/${handler.name}`;

      if (handler.ignoreWorkerBasePath) {
        handlerPath = `/${handler.name}`;
      }

      if (handler.name !== 'api-docs') {
        this.app.get(`${handlerPath}/openapi`, (() => {
          const specApp = new Hono<{ Bindings: WorkerEnv }>();
          const routerBase = getRouterBasePath(this.config);
          const prefix = routerBase === '/' ? handlerPath : `${routerBase}${handlerPath}`;
          specApp.route(prefix, handler.routes);

          let componentSchemas = {};
          if (handler.componentSchemas) {
            componentSchemas = handler.componentSchemas;
          }

          return openAPISpecs(specApp, {
            documentation: {
              info: {
                title: `${this.config.server.name} - ${handler.name}`,
                version: handler.version || this.config.server.version,
                description: `OpenAPI for handler ${handler.name}`,
              },
              components: {
                schemas: componentSchemas,
              },
            },
          });
        })());
      }

      // Mount handler routes with base path
      this.app.route(handlerPath, handler.routes);

      if (verbosity.includes('handler-add')) {
        this.startupStack.add(`Handler worker inclusion:`, {
          handler: handler.name,
          version: handler.version,
          path: handlerPath
        });
      }

      return this;
    } catch (error) {
      getLogger().error('Failed to add handler', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Initialize all handlers
  async initialize(env: WorkerEnv): Promise<void> {
    if (this.initialized) {
      return;
    }

    const workerLoggingConfig = getWorkerLoggingConfig(this.config, this.workerName);
    const verbosity = workerLoggingConfig.startupVerbosity || ['worker-registry', 'discovery-validation', 'handler-add', 'handler-init'];

    for (const handler of this.handlers) {
      if (handler.init) {
        try {
          await handler.init(env);
          if (verbosity.includes('handler-init')) {
            this.startupStack.add(`Handler ${handler.name} initialized`, { handler: handler.name });
          }
        } catch (error) {
          getLogger().error(`Failed to initialize handler ${handler.name}`, error instanceof Error ? error : new Error(String(error)), { handler: handler.name });
          throw error;
        }
      }
    }

    // Validate service discovery
    try {
      const discovery = getServiceDiscovery(env, this.config, this.workerName, appWorkerRegistry);
      if (verbosity.includes('discovery-validation')) {
        this.startupStack.add('Service discovery validation passed', {
          worker: this.workerName,
          handlers: discovery.initializedHandlers,
          services: discovery.availableServiceBindings.map(s => s.service)
        });
      }
    } catch (error) {
      this.startupStack.add('Service discovery validation failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    this.initialized = true;
    if (this.startupStack.count > 0) {
      this.startupStack.flush(LogLevel.DEBUG, `${this.workerName} Startup`);
    }
  }

  getApp(): Hono<{ Bindings: WorkerEnv }> {
    return this.app;
  }

  // Export handler for Cloudflare Workers runtime
  export() {
    const self = this;
    const queueFunction = this.getQueueFunction();

    const workerExport: any = {
      async fetch(request: any, env: WorkerEnv, ctx: any) {
        try {
          // Merge global and worker-specific vars into env
          const globalVars = (self.config as any).vars || {};
          const workerVars = (self.config.workers?.[self.workerName]?.vars) || {};
          const mergedEnv = { ...env, ...globalVars, ...workerVars } as WorkerEnv;

          // Inject CF location for pgEdge geo-routing
          // Header takes priority: request.cf reflects the worker's colo, not the original client
          const cfContinent = request.headers?.get?.('X-CF-Continent') || (request as any).cf?.continent;
          if (cfContinent) (mergedEnv as any).__cfContinent = cfContinent;

          await self.initialize(mergedEnv);
          return await self.app.fetch(request, mergedEnv, ctx);
        } catch (error) {
          getLogger().error('Worker error', error instanceof Error ? error : new Error(String(error)));
          return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
            server: self.config.server.name,
            worker: self.workerName
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    };

    if (queueFunction) {
      workerExport.queue = async (batch: any, env: WorkerEnv, ctx: any) => {
        const globalVars = (self.config as any).vars || {};
        const workerVars = (self.config.workers?.[self.workerName]?.vars) || {};
        const mergedEnv = { ...env, ...globalVars, ...workerVars } as WorkerEnv;
        await queueFunction(batch, mergedEnv, ctx);
      };
    }

    return workerExport;
  }
}

// Helper function to create handler array from imports
export function createHandlerArray(...handlers: AppHandler[]): Array<Promise<{ default: AppHandler }>> {
  return handlers.map(handler => Promise.resolve({ default: handler }));
}

// Convenience function to create a Cloudflare Worker from handler imports
export function createCloudflareWorker(
  workerName: string,
  handlers: Array<Promise<{ default: AppHandler }> | { default: AppHandler }>
) {
  return {
    async fetch(request: Request, env: WorkerEnv, ctx: any): Promise<Response> {
      try {
        const workerEnv = {
          ...env,
          WORKER_NAME: workerName
        };

        // Inject CF location for pgEdge geo-routing
        // Header takes priority: request.cf reflects the worker's colo, not the original client
        const cfContinent = request.headers?.get?.('X-CF-Continent') || (request as any).cf?.continent;
        if (cfContinent) (workerEnv as any).__cfContinent = cfContinent;

        const worker = await createWorker(workerEnv);

        for (const handler of handlers) {
          await worker.add(handler);
        }

        const workerExport = worker.export();
        return await workerExport.fetch(request, workerEnv, ctx);

      } catch (error) {
        getLogger().error(`${workerName} initialization error`, error instanceof Error ? error : new Error(String(error)));
        return new Response(JSON.stringify({
          success: false,
          error: `${workerName} initialization failed`,
          message: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    },

    async queue(batch: any, env: WorkerEnv, ctx: any): Promise<void> {
      try {
        const workerEnv = {
          ...env,
          WORKER_NAME: workerName
        };

        const worker = await createWorker(workerEnv);

        for (const handler of handlers) {
          await worker.add(handler);
        }

        const queueFunction = worker.getQueueFunction();

        if (!queueFunction) {
          getLogger().warn(`No queue function found in handlers for worker ${workerName}`);
          return;
        }

        await queueFunction(batch, workerEnv, ctx);

      } catch (error) {
        getLogger().error(`${workerName} queue processing error`, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  };
}
