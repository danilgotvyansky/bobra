import { Hono } from 'hono';
import type { Context } from 'hono';
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
  getWorkerMetricsConfig,
} from './config';
import { addMetricLabels, mergeMetricFamilies, parseMetricsDuration, serializePrometheus, type MetricFamily, type MetricsSnapshot } from '../batteries/metrics';
import { serviceDiscoveryMiddleware } from '../network/service-discovery';
import { generateSpecs } from 'hono-openapi';
import type { OpenAPIV3 } from 'openapi-types';
import type { MessageBatch, ExecutionContext, ScheduledController } from '@cloudflare/workers-types';

const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type OpenApiMethod = typeof OPENAPI_METHODS[number];
type HonoBindingsEnv = { Bindings: Record<string, unknown>; Variables?: Record<string, unknown> };
type HonoHandler<E extends HonoBindingsEnv> = (c: Context<E>) => unknown;
type RoutableHono<E extends HonoBindingsEnv> = Hono<E> & {
  use: (path: string, ...handlers: unknown[]) => RoutableHono<E>;
  get: (path: string, handler: HonoHandler<E>) => RoutableHono<E>;
  route: (path: string, app: unknown) => RoutableHono<E>;
  fetch: (request: Request, env?: E['Bindings'], ctx?: WorkerExecutionCtx) => Promise<Response> | Response;
};

type JsonNode = string | number | boolean | null | JsonNode[] | { [key: string]: JsonNode };
type QueuePayload = Record<string, string | number | boolean | null>;
type QueueBatch = MessageBatch<QueuePayload>;
type WorkerExecutionCtx = ExecutionContext;
type ScheduledEvent = ScheduledController;
type SchemaMap = Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>;
type SecuritySchemeMap = Record<string, OpenAPIV3.SecuritySchemeObject | OpenAPIV3.ReferenceObject>;
type MetricsCacheStub = { readSnapshot(key: string): Promise<MetricsSnapshot | undefined>; writeSnapshot(key: string, snapshot: MetricsSnapshot): Promise<void>; deleteSnapshot(key: string): Promise<void>; acquireLease(key: string, holder: string, ttlMs: number): Promise<boolean>; releaseLease(key: string, holder: string): Promise<void> };
type MetricsCoordinatorStub = MetricsCacheStub & { readMergedSnapshot(): Promise<MetricsSnapshot | undefined>; refresh(): Promise<MetricsSnapshot>; scheduleNext(at: number): Promise<void> };
type MetricsCacheNamespace = { getByName(name: string): MetricsCacheStub };

interface RequestWithCf extends Request {
  cf?: Record<string, unknown> & {
    continent?: string;
    colo?: string;
  };
}

function isJsonObject(node: JsonNode): node is { [key: string]: JsonNode } {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

function isPathItemObject(item: OpenAPIV3.PathItemObject | OpenAPIV3.ReferenceObject): item is OpenAPIV3.PathItemObject {
  return !('$ref' in item);
}

function hasOperation(pathItem: OpenAPIV3.PathItemObject): boolean {
  return OPENAPI_METHODS.some((method) => Boolean(pathItem[method]));
}

// Helper: collect schema $ref names referenced anywhere in the OpenAPI spec
function collectReferencedSchemaNames(obj: JsonNode): Set<string> {
  const set = new Set<string>();
  function scan(val: JsonNode) {
    if (Array.isArray(val)) {
      for (const item of val) scan(item);
      return;
    }

    if (isJsonObject(val)) {
      for (const [k, value] of Object.entries(val)) {
        if (k === '$ref' && typeof value === 'string') {
          const m = value.match(/^#\/components\/schemas\/([A-Za-z0-9_.-]+)/);
          if (m && m[1]) set.add(m[1]);
        } else {
          scan(value);
        }
      }
    }
  }
  scan(obj);
  return set;
}

function pruneComponents(
  full: OpenAPIV3.Document,
  paths: OpenAPIV3.PathsObject,
  keepAlways: string[] = []
): OpenAPIV3.ComponentsObject {
  const result: OpenAPIV3.ComponentsObject = { ...(full.components || {}) };
  const schemas = (full.components?.schemas || {}) as SchemaMap;

  // Start with schemas referenced directly from paths
  const refs = collectReferencedSchemaNames(paths as JsonNode);

  // Always-keep schemas should be included in the starting set as well
  for (const name of keepAlways) {
    refs.add(name);
  }

  const kept: SchemaMap = {};

  // Traverse schema references transitively using a work queue to ensure 
  // nested dependencies are not pruned.
  const toVisit: string[] = Array.from(refs);
  while (toVisit.length > 0) {
    const name = toVisit.pop() as string;
    const schema = schemas[name];

    if (!schema || kept[name]) {
      continue;
    }

    // Keep this schema
    kept[name] = schema;

    // Find referenced schemas and add them to the queue if not already seen
    const nestedRefs = collectReferencedSchemaNames(schema as JsonNode);
    for (const dep of nestedRefs) {
      if (!refs.has(dep)) {
        refs.add(dep);
        toVisit.push(dep);
      }
    }
  }

  result.schemas = kept;
  return result;
}

export interface OpenAPISpecOptions {
  /** The path where the OpenAPI spec will be served (e.g. '/openapi', '/internal/openapi') */
  path?: string;
  /** Return true to exclude an operation from the generated OpenAPI spec */
  excludeEndpoint?: (path: string, method: OpenApiMethod, operation: OpenAPIV3.OperationObject) => boolean;
  /** Exclude operations that have one of these tags (e.g. ['internal']) */
  excludeTags?: string[];
  /** Whether or not to prune unreferenced OpenAPI component schemas (defaults to true if exclusions are used) */
  pruneComponents?: boolean;
  /** An array of schema names to always keep in the OpenAPI spec if pruneComponents is true */
  pruneComponentsKeepAlways?: string[];
  /** Additional security schemes to add to the OpenAPI spec */
  securitySchemes?: SecuritySchemeMap;
}

export interface WorkerOptions {
  openapi?: OpenAPISpecOptions | OpenAPISpecOptions[];
}

// Worker environment interface
export interface WorkerEnv {
  CONFIG_CONTENT?: string;
  WORKER_NAME?: string;
  __cfContinent?: string;
  __cfColo?: string;
  // Bindings are deployment-specific and can include D1/KV/R2/DO namespaces.
  [key: string]: unknown;
}

// Create a new worker instance with common middleware
export async function createWorker(env?: WorkerEnv, options?: WorkerOptions): Promise<AppWorker> {
  const app = new Hono<HonoBindingsEnv>() as RoutableHono<HonoBindingsEnv>;

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
  (() => {
    const specApp = new Hono<HonoBindingsEnv>() as RoutableHono<HonoBindingsEnv>;
    const routerBase = getRouterBasePath(config);
    // Mount the worker app under router base path so generated paths include router base
    specApp.route(routerBase === '/' ? '/' : routerBase, app);

    const specOptions = {
      documentation: {
        info: {
          title: config.server.name,
          version: config.server.version,
          description: config.server.description,
        },
      },
    };

    const specDefs = options?.openapi
      ? (Array.isArray(options.openapi) ? options.openapi : [options.openapi])
      : [{ path: '/openapi' }];

    for (const specDef of specDefs) {
      const specPath = specDef.path || '/openapi';
      app.get(specPath, async (c) => {
        const full = await generateSpecs(specApp, specOptions as Parameters<typeof generateSpecs>[1]) as OpenAPIV3.Document;
        const { excludeEndpoint, excludeTags, pruneComponents: specPrune, securitySchemes } = specDef;
        const hasExclusions = !!excludeEndpoint || (!!excludeTags && excludeTags.length > 0);

        let finalSpec = full;

        if (hasExclusions) {
          const filtered: OpenAPIV3.Document = { ...full, paths: {} };
          for (const [path, pathItemOrRef] of Object.entries(full.paths ?? {}) as Array<[string, OpenAPIV3.PathItemObject | OpenAPIV3.ReferenceObject]>) {
            if (!pathItemOrRef) continue;

            if (!isPathItemObject(pathItemOrRef)) {
              filtered.paths[path] = pathItemOrRef;
              continue;
            }

            const keepPathItem: OpenAPIV3.PathItemObject = { ...pathItemOrRef };

            for (const method of OPENAPI_METHODS) {
              const operation = pathItemOrRef[method];
              if (!operation) continue;

              let shouldExclude = false;
              if (excludeEndpoint && excludeEndpoint(path, method, operation)) {
                shouldExclude = true;
              }

              if (!shouldExclude && excludeTags && Array.isArray(operation.tags)) {
                if (operation.tags.some((tag: string) => excludeTags.includes(tag))) {
                  shouldExclude = true;
                }
              }

              if (shouldExclude) {
                delete keepPathItem[method];
              }
            }

            if (hasOperation(keepPathItem) || Boolean(keepPathItem.parameters?.length)) {
              filtered.paths[path] = keepPathItem;
            }
          }

          const shouldPrune = specPrune ?? true;
          if (shouldPrune) {
            filtered.components = pruneComponents(full, filtered.paths, specDef.pruneComponentsKeepAlways || []);
          } else {
            filtered.components = full.components;
          }
          finalSpec = filtered;
        }

        if (securitySchemes) {
          finalSpec = {
            ...finalSpec,
            components: {
              ...(finalSpec.components || {}),
              securitySchemes: {
                ...(finalSpec.components?.securitySchemes || {}),
                ...securitySchemes
              }
            }
          };
        }

        return c.json(finalSpec, 200);
      });
    }
  })();

  return new AppWorker(app, config, workerName, basePath, options);
}

// Core worker class that manages handlers and their lifecycle
export class AppWorker {
  private app: RoutableHono<HonoBindingsEnv>;
  private handlers: AppHandler[] = [];
  private config: AppConfig;
  private workerName: string;
  private basePath: string;
  private options?: WorkerOptions;
  private initialized = false;
  private startupStack = new LogStack();

  private async collectHandlerMetrics(handler: AppHandler, env: WorkerEnv, request?: Request): Promise<MetricFamily[]> {
    if (!handler.metrics) return [];
    const metrics = getWorkerMetricsConfig(this.config, this.workerName);
    const labels: Record<string, string> = {};
    if (metrics.labels.source.enabled) {
      labels[metrics.labels.source.app] = this.config.server.name;
      labels[metrics.labels.source.worker] = this.workerName;
      labels[metrics.labels.source.handler] = handler.name;
    }
    for (const [key, value] of Object.entries(metrics.labels.static)) if (value !== null) labels[key] = value;
    const families = await handler.metrics.collect({ env, workerName: this.workerName, handlerName: handler.name, request });
    return addMetricLabels(families, labels);
  }

  private getMetricsCache(env: WorkerEnv, coordinator = false): MetricsCacheStub | undefined {
    const binding = env[coordinator ? 'BOBRA_METRICS_COORDINATOR' : 'BOBRA_METRICS_CACHE'] as MetricsCacheNamespace | undefined;
    return binding?.getByName(`${this.config.server.name}:${this.workerName}`);
  }

  private getMetricsCoordinator(env: WorkerEnv): MetricsCoordinatorStub | undefined {
    return this.getMetricsCache(env, true) as MetricsCoordinatorStub | undefined;
  }

  private async getObservabilityMetrics(handler: AppHandler, env: WorkerEnv, request: Request): Promise<MetricFamily[]> {
    const policy = getWorkerMetricsConfig(this.config, this.workerName);
    const localProviders = this.handlers.filter((candidate) => candidate.name !== 'observability' && candidate.metrics);
    const localFamilies = localProviders.length > 0
      ? await Promise.all(localProviders.map((provider) => this.getDirectMetrics(provider, env, request)))
      : [];
    const hasExternalProviders = Object.entries(this.config.workers).some(([name, worker]) => name !== this.workerName && getWorkerMetricsConfig(this.config, name).enabled && !worker.handlers.includes('observability'));
    if (!hasExternalProviders) return mergeMetricFamilies(localFamilies);
    if (!policy.cache.enabled) return mergeMetricFamilies([await handler.metrics!.collect({ env, workerName: this.workerName, handlerName: handler.name, request }), ...localFamilies]);
    const coordinator = policy.cache.enabled ? this.getMetricsCoordinator(env) : undefined;
    if (!coordinator) throw new Error('Observability metrics require the configured coordinator Durable Object');
    const now = Date.now();
    const snapshot = await coordinator.readMergedSnapshot();
    if (snapshot && now - snapshot.collectedAt <= parseMetricsDuration(policy.cache.freshness)) return mergeMetricFamilies([snapshot.families, ...localFamilies]);
    const refreshed = await coordinator.refresh();
    await coordinator.scheduleNext(Date.now() + parseMetricsDuration(policy.cache.freshness));
    return mergeMetricFamilies([refreshed.families, ...localFamilies]);
  }

  private async getDirectMetrics(handler: AppHandler, env: WorkerEnv, request: Request): Promise<MetricFamily[]> {
    const policy = getWorkerMetricsConfig(this.config, this.workerName);
    const cache = policy.cache.enabled ? this.getMetricsCache(env) ?? this.getMetricsCoordinator(env) : undefined;
    const key = `handler:${handler.name}`;
    const now = Date.now();
    let stale: MetricsSnapshot | undefined;
    if (cache) {
      const stored = await cache.readSnapshot(key);
      if (stored) {
        if (now - stored.collectedAt <= parseMetricsDuration(policy.cache.freshness)) return stored.families;
        stale = stored;
      }
    }
    const holder = crypto.randomUUID();
    if (cache && !await cache.acquireLease(key, holder, parseMetricsDuration(policy.cache.provider_timeout))) {
      if (stale && now - stale.collectedAt <= parseMetricsDuration(policy.cache.max_staleness)) return stale.families;
      throw new Error(`Metrics refresh already in progress for handler '${handler.name}'`);
    }
    try {
      const families = await this.collectHandlerMetrics(handler, env, request);
      if (cache) await cache.writeSnapshot(key, { collectedAt: now, families });
      return families;
    } finally {
      if (cache) await cache.releaseLease(key, holder);
    }
  }

  private async hasInternalMetricsAuth(request: Request, env: WorkerEnv): Promise<boolean> {
    const binding = this.config.metrics?.internal_token_binding;
    const expected = binding ? env[binding] : undefined;
    const provided = request.headers.get('X-Internal-Token');
    if (typeof expected !== 'string' || !provided) return false;
    const encoder = new TextEncoder();
    const [expectedHash, providedHash] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(expected)),
      crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    ]);
    const left = new Uint8Array(expectedHash);
    const right = new Uint8Array(providedHash);
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
    return difference === 0;
  }

  constructor(app: RoutableHono<HonoBindingsEnv>, config: AppConfig, workerName: string, basePath: string, options?: WorkerOptions) {
    this.app = app;
    this.config = config;
    this.workerName = workerName;
    this.basePath = basePath;
    this.options = options;

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
  getQueueFunction(): ((batch: QueueBatch, env: WorkerEnv, ctx: WorkerExecutionCtx) => Promise<void>) | undefined {
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

    return async (batch: QueueBatch, env: WorkerEnv, ctx: WorkerExecutionCtx) => {
      await this.initialize(env);

      // Build configured queue name list from config for this worker
      let configuredQueues: string[] = [];
      try {
        const bindings = getWorkerQueueBindings(this.config, this.workerName);
        const consumers = bindings.consumers ?? [];
        configuredQueues = consumers
          .map((consumer) => consumer.queue)
          .filter((queueName): queueName is string => typeof queueName === 'string' && queueName.length > 0);
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

  getScheduledFunction(): ((event: ScheduledEvent, env: WorkerEnv, ctx: WorkerExecutionCtx) => Promise<void>) | undefined {
    const scheduledHandlers = this.handlers.filter(h => typeof h.scheduled === 'function');

    if (scheduledHandlers.length === 0) {
      return undefined;
    }

    return async (event: ScheduledEvent, env: WorkerEnv, ctx: WorkerExecutionCtx) => {
      await this.initialize(env);

      const promises = scheduledHandlers.map(async (handler) => {
        try {
          const logger = getLogger();
          try {
            logger.setHandler?.(handler.name);
            await handler.scheduled!(event, env, ctx);
          } finally {
            logger.setHandler?.('');
          }
        } catch (error) {
          getLogger().error(`Scheduled task error in handler ${handler.name}`, error instanceof Error ? error : new Error(String(error)));
        }
      });

      await Promise.all(promises);
    };
  }

  // Add a handler to the worker
  async add(handlerModule: Promise<{ default: AppHandler }> | { default: AppHandler }): Promise<this> {
    try {
      const module = await handlerModule;
      const handler = module.default;

      if (handler.metrics && this.config.metrics?.enabled && !getWorkerMetricsConfig(this.config, this.workerName).enabled) {
        throw new Error(`Handler '${handler.name}' declares metrics but worker '${this.workerName}' has metrics disabled`);
      }

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

      const metricsConfig = getWorkerMetricsConfig(this.config, this.workerName);
      if (metricsConfig.enabled && handler.metrics) {
        const endpointPath = metricsConfig.endpoint_path.startsWith('/') ? metricsConfig.endpoint_path : `/${metricsConfig.endpoint_path}`;
        this.app.get(`${handlerPath}${endpointPath}`, async (c) => {
          try {
            const families = handler.name === 'observability'
              ? await this.getObservabilityMetrics(handler, c.env as WorkerEnv, c.req.raw)
              : await this.getDirectMetrics(handler, c.env as WorkerEnv, c.req.raw);
            return new Response(serializePrometheus(families), { headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' } });
          } catch (error) {
            getLogger().error(`Metrics collection failed for handler ${handler.name}`, error instanceof Error ? error : new Error(String(error)));
            return new Response('metrics collection failed\n', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
          }
        });
      }

      if (handler.name !== 'api-docs') {
        (() => {
          const specApp = new Hono<HonoBindingsEnv>() as RoutableHono<HonoBindingsEnv>;
          const routerBase = getRouterBasePath(this.config);
          const prefix = routerBase === '/' ? handlerPath : `${routerBase}${handlerPath}`;
          specApp.route(prefix, handler.routes);

          const componentSchemas = (handler.componentSchemas || {}) as SchemaMap;
          const handlerSecuritySchemes = (handler.securitySchemes || {}) as SecuritySchemeMap;

          const specOptions = {
            documentation: {
              info: {
                title: `${this.config.server.name} - ${handler.name}`,
                version: handler.version || this.config.server.version,
                description: `OpenAPI for handler ${handler.name}`,
              },
              components: {
                schemas: componentSchemas,
                securitySchemes: handlerSecuritySchemes,
              },
            },
          };

          const specDefs = this.options?.openapi
            ? (Array.isArray(this.options.openapi) ? this.options.openapi : [this.options.openapi])
            : [{ path: '/openapi' }];

          for (const specDef of specDefs) {
            const specPath = specDef.path || '/openapi';
            this.app.get(`${handlerPath}${specPath}`, async (c) => {
              const full = await generateSpecs(specApp, specOptions as Parameters<typeof generateSpecs>[1]) as OpenAPIV3.Document;
              const { excludeEndpoint, excludeTags, pruneComponents: specPrune, securitySchemes } = specDef;
              const hasExclusions = !!excludeEndpoint || (!!excludeTags && excludeTags.length > 0);

              let finalSpec = full;

              if (hasExclusions) {
                const filtered: OpenAPIV3.Document = { ...full, paths: {} };
                for (const [path, pathItemOrRef] of Object.entries(full.paths ?? {}) as Array<[string, OpenAPIV3.PathItemObject | OpenAPIV3.ReferenceObject]>) {
                  if (!pathItemOrRef) continue;

                  if (!isPathItemObject(pathItemOrRef)) {
                    filtered.paths[path] = pathItemOrRef;
                    continue;
                  }

                  const keepPathItem: OpenAPIV3.PathItemObject = { ...pathItemOrRef };

                  for (const method of OPENAPI_METHODS) {
                    const operation = pathItemOrRef[method];
                    if (!operation) continue;

                    let shouldExclude = false;
                    if (excludeEndpoint && excludeEndpoint(path, method, operation)) {
                      shouldExclude = true;
                    }

                    if (!shouldExclude && excludeTags && Array.isArray(operation.tags)) {
                      if (operation.tags.some((tag: string) => excludeTags.includes(tag))) {
                        shouldExclude = true;
                      }
                    }

                    if (shouldExclude) {
                      delete keepPathItem[method];
                    }
                  }

                  if (hasOperation(keepPathItem) || Boolean(keepPathItem.parameters?.length)) {
                    filtered.paths[path] = keepPathItem;
                  }
                }

                const shouldPrune = specPrune ?? true;
                if (shouldPrune) {
                  filtered.components = pruneComponents(full, filtered.paths, specDef.pruneComponentsKeepAlways || []);
                } else {
                  filtered.components = full.components;
                }
                finalSpec = filtered;
              }

              if (securitySchemes) {
                finalSpec = {
                  ...finalSpec,
                  components: {
                    ...(finalSpec.components || {}),
                    securitySchemes: {
                      ...(finalSpec.components?.securitySchemes || {}),
                      ...securitySchemes
                    }
                  }
                };
              }

              return c.json(finalSpec, 200);
            });
          }
        })();
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

  mountInternalMetricsCollector(): void {
    const metrics = getWorkerMetricsConfig(this.config, this.workerName);
    if (!metrics.enabled) return;
    const internalPath = '/_bobra/metrics/collect';
    this.app.post(internalPath, async (c) => {
      try {
        if (!await this.hasInternalMetricsAuth(c.req.raw, c.env as WorkerEnv)) return c.json({ error: 'forbidden' }, 403);
        const requested: { handlers?: string[] } = await c.req.json<{ handlers?: string[] }>().catch(() => ({}));
        const selected = this.handlers.filter((handler) => handler.metrics && (!requested.handlers || requested.handlers.includes(handler.name)));
        const groups = await Promise.all(selected.map((handler) => this.collectHandlerMetrics(handler, c.env as WorkerEnv, c.req.raw)));
        return c.json({ families: mergeMetricFamilies(groups) });
      } catch (error) {
        getLogger().error('Internal metrics collection failed', error instanceof Error ? error : new Error(String(error)));
        return c.json({ error: 'metrics collection failed' }, 503);
      }
    });
  }

  // Initialize all handlers
  async initialize(env: WorkerEnv): Promise<void> {
    if (this.initialized) {
      return;
    }

    const workerLoggingConfig = getWorkerLoggingConfig(this.config, this.workerName);
    const metricsConfig = getWorkerMetricsConfig(this.config, this.workerName);
    if (metricsConfig.enabled && !this.handlers.some((handler) => handler.metrics)) {
      throw new Error(`Metrics-enabled worker '${this.workerName}' has no metrics provider`);
    }
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

  getApp(): Hono<HonoBindingsEnv> {
    return this.app;
  }

  // Export handler for Cloudflare Workers runtime
  export() {
    const self = this;
    const queueFunction = this.getQueueFunction();
    const scheduledFunction = this.getScheduledFunction();

    const workerExport: {
      fetch: (request: RequestWithCf, env: WorkerEnv, ctx: WorkerExecutionCtx) => Promise<Response>;
      queue?: (batch: QueueBatch, env: WorkerEnv, ctx: WorkerExecutionCtx) => Promise<void>;
      scheduled?: (event: ScheduledEvent, env: WorkerEnv, ctx: WorkerExecutionCtx) => Promise<void>;
    } = {
      async fetch(request: RequestWithCf, env: WorkerEnv, ctx: WorkerExecutionCtx) {
        try {
          // Merge global and worker-specific vars into env
          const globalVars = self.config.vars || {};
          const workerVars = (self.config.workers?.[self.workerName]?.vars) || {};
          const mergedEnv = { ...env, ...globalVars, ...workerVars } as WorkerEnv;

          // Inject CF location for pgEdge geo-routing
          // Header takes priority: request.cf reflects the worker's colo, not the original client
          const cfContinent = request.headers?.get?.('X-CF-Continent') || request.cf?.continent;
          if (cfContinent) mergedEnv.__cfContinent = cfContinent;
          const cfColo = request.headers?.get?.('X-CF-Colo') || request.cf?.colo;
          if (cfColo) mergedEnv.__cfColo = cfColo;

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
      workerExport.queue = async (batch: QueueBatch, env: WorkerEnv, ctx: WorkerExecutionCtx) => {
        const globalVars = self.config.vars || {};
        const workerVars = (self.config.workers?.[self.workerName]?.vars) || {};
        const mergedEnv = { ...env, ...globalVars, ...workerVars } as WorkerEnv;
        await queueFunction(batch, mergedEnv, ctx);
      };
    }

    if (scheduledFunction) {
      workerExport.scheduled = async (event: ScheduledEvent, env: WorkerEnv, ctx: WorkerExecutionCtx) => {
        const globalVars = self.config.vars || {};
        const workerVars = (self.config.workers?.[self.workerName]?.vars) || {};
        const mergedEnv = { ...env, ...globalVars, ...workerVars } as WorkerEnv;
        await scheduledFunction(event, mergedEnv, ctx);
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
  handlers: Array<Promise<{ default: AppHandler }> | { default: AppHandler }>,
  options?: WorkerOptions
) {
  return {
    async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionCtx): Promise<Response> {
      try {
        const workerEnv = {
          ...env,
          WORKER_NAME: workerName
        };

        // Inject CF location for pgEdge geo-routing
        // Header takes priority: request.cf reflects the worker's colo, not the original client
        const requestWithCf = request as RequestWithCf;
        const cfContinent = request.headers?.get?.('X-CF-Continent') || requestWithCf.cf?.continent;
        if (cfContinent) workerEnv.__cfContinent = cfContinent;
        const cfColo = request.headers?.get?.('X-CF-Colo') || requestWithCf.cf?.colo;
        if (cfColo) workerEnv.__cfColo = cfColo;

        const worker = await createWorker(workerEnv, options);

        for (const handler of handlers) {
          await worker.add(handler);
        }

        worker.mountInternalMetricsCollector();

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

    async queue(batch: QueueBatch, env: WorkerEnv, ctx: WorkerExecutionCtx): Promise<void> {
      try {
        const workerEnv = {
          ...env,
          WORKER_NAME: workerName
        };

        const worker = await createWorker(workerEnv, options);

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
    },

    async scheduled(event: ScheduledEvent, env: WorkerEnv, ctx: WorkerExecutionCtx): Promise<void> {
      try {
        const workerEnv = {
          ...env,
          WORKER_NAME: workerName
        };

        const worker = await createWorker(workerEnv);

        for (const handler of handlers) {
          await worker.add(handler);
        }
        const scheduledFunction = worker.getScheduledFunction();

        if (!scheduledFunction) {
          getLogger().warn(`No scheduled function found in handlers for worker ${workerName}`);
          return;
        }

        await scheduledFunction(event, workerEnv, ctx);

      } catch (error) {
        getLogger().error(`${workerName} scheduled task error`, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  };
}
