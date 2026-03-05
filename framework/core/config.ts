import { load } from 'js-yaml';
import type { LoggerConfig } from '../logging/logger';
import { JSONValue } from 'hono/utils/types';
import { resolveConfig } from './env-resolver';

// Configuration interfaces
export interface CorsConfig {
  origin: string[];
  allowMethods: string[];
  allowHeaders: string[];
}

export interface ServerConfig {
  name: string;
  version: string;
  description: string;
}

export interface HyperdriveConfig {
  binding: string;
  id: string;
  localConnectionString: string;
}

export interface D1Config {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir: string;
}

export interface WorkerQueueProducerConfig {
  binding: string;
  queue: string;
}

export interface WorkerQueueConsumerConfig {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  dead_letter_queue?: string;
  max_concurrency?: number;
  retry_delay?: number;
}

export interface WorkerQueuesConfig {
  producers?: WorkerQueueProducerConfig[];
  consumers?: WorkerQueueConsumerConfig[];
}

export interface WorkerKvNamespaceConfig {
  binding: string;
  id?: string;
  preview_id?: string;
}

export interface WorkerDurableObjectBinding {
  binding: string;
  class_name: string;
  script_name?: string;
}

export interface WorkerDatabaseConfig {
  postgres?: HyperdriveConfig | Record<string, HyperdriveConfig>;
  d1?: D1Config;
}

export interface PgEdgeConfig {
  enabled: boolean;
  locations: string[];
}

export interface CloudflareRoute {
  pattern: string;
  custom_domain?: boolean;
  zone_id?: string;
  zone_name?: string;
}

export interface WorkerConfig {
  name: string;
  port?: number;
  inspector_port?: number;
  description?: string;
  main?: string;
  base_path?: string;
  db_engine?: 'postgres' | 'd1-sqlite' | 'auto-detect';
  cors?: Partial<CorsConfig>;
  logging?: Partial<LoggerConfig>;
  handlers: string[];
  queues?: WorkerQueuesConfig;
  database?: WorkerDatabaseConfig;
  durable_objects?: WorkerDurableObjectBinding[];
  services?: Array<{
    binding: string;
    service: string;
    external_url?: string;
  }>;
  kv_namespaces?: WorkerKvNamespaceConfig[];
  vars?: Record<string, string | number | boolean | JSONValue>;
  cf_routes?: CloudflareRoute[];
  observability?: {
    logs?: {
      enabled?: boolean;
    };
  };
}

export interface RouterConfig {
  name: string;
  port?: number;
  inspector_port?: number;
  description?: string;
  main?: string;
  base_path?: string;
  cors?: Partial<CorsConfig>;
  logging?: Partial<LoggerConfig>;
  routes: Array<{
    path: string;
    service: string;
  }>;
  services?: Array<{
    binding: string;
    service: string;
    external_url?: string;
  }>;
  kv_namespaces?: WorkerKvNamespaceConfig[];
  vars?: Record<string, string | number | boolean | JSONValue>;
  cf_routes?: CloudflareRoute[];
  observability?: {
    logs?: {
      enabled?: boolean;
    };
  };
}

// Route configuration interface
export interface RouteConfig {
  path: string;
  service: string;
  description?: string;
}

export interface AppConfig {
  cors: CorsConfig;
  server: ServerConfig;
  db_engine: 'postgres' | 'd1-sqlite' | 'auto-detect';
  deployment_context?: 'cloudflare' | 'self-hosted';
  logging?: LoggerConfig;
  pgEdge: PgEdgeConfig;
  vars?: Record<string, string | number | boolean | JSONValue>;
  workers: Record<string, WorkerConfig>;
  router: RouterConfig;
}

// Default configuration — apps should override these via their config.yml
export const defaultConfig: AppConfig = {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:8700'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  },
  server: {
    name: 'example-app',
    version: '0.1.0',
    description: 'Bobra Framework Application',
  },
  pgEdge: {
    enabled: false,
    locations: [],
  },
  db_engine: 'postgres',
  vars: {},
  workers: {},
  router: {
    name: 'example-app-router-worker',
    port: 8700,
    description: 'Central routing worker',
    main: 'src/index.ts',
    routes: [],
  },
};

// Load configuration from YAML content
export function parseConfig(yamlContent: string, env?: Record<string, any>): AppConfig {
  try {
    const parsed = load(yamlContent) as Partial<AppConfig>;

    // Merge with default config
    let config: AppConfig = {
      cors: {
        ...defaultConfig.cors,
        ...parsed.cors,
      },
      server: {
        ...defaultConfig.server,
        ...parsed.server,
      },
      db_engine: parsed.db_engine || defaultConfig.db_engine,
      pgEdge: parsed.pgEdge || defaultConfig.pgEdge,
      logging: parsed.logging,
      vars: parsed.vars || {},
      workers: parsed.workers || {},
      router: {
        ...defaultConfig.router,
        ...parsed.router,
      },
    };

    // Resolve environment variables if env is provided
    if (env) {
      // For worker runtime: env already contains all vars from wrangler (.dev.vars + secrets)
      const resolved = resolveConfig(config as Record<string, any>, env);
      config = resolved as AppConfig;
    }

    return config;
  } catch (error) {
    console.error('Failed to parse YAML configuration:', error);
    throw new Error(`Invalid YAML configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Cache for parsed configuration to avoid repeated decompression/parsing
let configCache: { content: string; config: AppConfig } | null = null;

// Load configuration from environment or use default
export async function loadConfig(env?: { CONFIG_CONTENT?: string;[key: string]: any }): Promise<AppConfig> {
  const configContent = env?.CONFIG_CONTENT;

  if (configContent) {
    // Return cached config if content matches
    if (configCache && configCache.content === configContent) {
      return configCache.config;
    }

    try {
      let config: AppConfig;

      // Check for Gzip magic number in Base64 (H4sI)
      if (configContent.startsWith('H4sI')) {
        // Decompress: Base64 -> binary -> gunzip -> text
        const binaryString = atob(configContent);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const decompressed = await new Response(stream).text();
        config = parseConfig(decompressed, env);
      } else {
        // Fallback: assume plain text
        config = parseConfig(configContent, env);
      }

      // Update cache
      configCache = { content: configContent, config };
      return config;

    } catch (e) {
      console.warn('Failed to decompress or parse config:', e);
      // If the content looks like Base64-gzipped data, a plain-text YAML parse will never succeed.
      if (configContent.startsWith('H4sI')) {
        const message = 'Failed to decompress Base64-gzipped CONFIG_CONTENT (invalid Base64/gzip data or missing DecompressionStream support).';
        const err = new Error(message); (err as any).cause = e; throw err;
      }
      return parseConfig(configContent, env);
    }
  }

  console.log('No configuration provided, using default config');
  return defaultConfig;
}

// Utility function to convert service name to binding name
export function serviceToBindingName(serviceName: string): string {
  return serviceName.toUpperCase().replace(/-/g, '_');
}

// Utility function to get database binding configuration for a specific worker
export function getDatabaseBinding(config: AppConfig, workerName: string) {
  const db_engine = getWorkerDbEngine(config, workerName);
  const worker = config.workers[workerName];

  if (!worker?.database) {
    throw new Error(`No database configuration found for worker: ${workerName}`);
  }

  const workerDb = worker.database;

  if (db_engine === 'postgres' && workerDb.postgres) {
    return {
      type: 'hyperdrive' as const,
      config: workerDb.postgres,
    };
  }

  if (db_engine === 'd1-sqlite' && workerDb.d1) {
    return {
      type: 'd1' as const,
      config: workerDb.d1,
    };
  }

  // Auto-detect fallback
  if (workerDb.postgres) {
    return {
      type: 'hyperdrive' as const,
      config: workerDb.postgres,
    };
  }

  if (workerDb.d1) {
    return {
      type: 'd1' as const,
      config: workerDb.d1,
    };
  }

  throw new Error(`No database configuration found for db_engine: ${db_engine} (worker: ${workerName})`);
}

// Utility function to get queue bindings for a worker
export function getWorkerQueueBindings(config: AppConfig, workerName: string) {
  const worker = config.workers?.[workerName];
  const producers: WorkerQueueProducerConfig[] = [];
  const consumers: WorkerQueueConsumerConfig[] = [];

  if (!worker?.queues) {
    return { producers, consumers };
  }

  if (worker.queues.producers) {
    producers.push(...worker.queues.producers);
  }

  if (worker.queues.consumers) {
    consumers.push(...worker.queues.consumers);
  }

  return { producers, consumers };
}

// Helper function to normalize path (remove trailing slash, ensure leading slash)
export function normalizePath(path: string): string {
  if (!path || path === '/') return '/';

  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  if (path.length > 1) {
    path = path.replace(/\/+$/, '');
  }

  return path;
}

// Helper function to get router base path with default
export function getRouterBasePath(config: AppConfig): string {
  return normalizePath(config.router?.base_path || '/');
}

// Helper function to get router worker name from config
export function getRouterWorkerName(config: AppConfig): string {
  return config.router?.name || '';
}

// Helper function to get worker base path with default
export function getWorkerBasePath(config: AppConfig, workerName: string): string {
  const worker = config.workers?.[workerName];
  return normalizePath(worker?.base_path || '/api');
}

// Get logging configuration for a specific worker
export function getWorkerLoggingConfig(config: AppConfig, workerName: string): Partial<LoggerConfig> {
  const worker = config.workers?.[workerName];
  return {
    ...config.logging,
    ...worker?.logging
  };
}

// Get database engine for a specific worker (with override support)
export function getWorkerDbEngine(config: AppConfig, workerName: string): 'postgres' | 'd1-sqlite' | 'auto-detect' {
  const worker = config.workers?.[workerName];
  return worker?.db_engine || config.db_engine;
}

// Get CORS configuration for a specific worker (with override support)
export function getWorkerCorsConfig(config: AppConfig, workerName: string): CorsConfig {
  const worker = config.workers?.[workerName];
  return {
    ...config.cors,
    ...worker?.cors
  };
}

// Get router CORS configuration (with override support)
export function getRouterCorsConfig(config: AppConfig): CorsConfig {
  return {
    ...config.cors,
    ...config.router?.cors
  };
}

// Route configuration interface
export interface RouteConfig {
  path: string;
  service: string;
  description?: string;
}

// Validate configuration
export function validateConfig(config: AppConfig): void {
  if (!config.server?.name) {
    throw new Error('Server name is required in configuration');
  }

  if (!config.server?.version) {
    throw new Error('Server version is required in configuration');
  }

  if (!config.cors?.origin || !Array.isArray(config.cors.origin)) {
    throw new Error('CORS origin must be an array');
  }

  if (!config.cors?.allowMethods || !Array.isArray(config.cors.allowMethods)) {
    throw new Error('CORS allowMethods must be an array');
  }

  if (!config.cors?.allowHeaders || !Array.isArray(config.cors.allowHeaders)) {
    throw new Error('CORS allowHeaders must be an array');
  }

  // Validate no duplicate handler/service IDs across workers
  const routerWorkerName = getRouterWorkerName(config);
  const allHandlerIds = new Set<string>();
  const allServiceIds = new Set<string>();

  for (const [workerName, worker] of Object.entries(config.workers || {})) {
    for (const handlerId of worker.handlers || []) {
      if (allHandlerIds.has(handlerId)) {
        throw new Error(`Duplicate handler ID '${handlerId}' found in multiple workers`);
      }
      allHandlerIds.add(handlerId);
    }

    // Skip duplicate check for router service — it's allowed since every worker binds to it
    for (const service of worker.services || []) {
      if (service.service === routerWorkerName) {
        continue;
      }

      if (allServiceIds.has(service.service)) {
        throw new Error(`Duplicate service ID '${service.service}' found in multiple workers`);
      }
      allServiceIds.add(service.service);
    }
  }
}

// Helper function to get service binding with direct call fallback
export function getServiceBindingWithFallback(
  env: any,
  bindingName: string,
  config: AppConfig,
  workerName: string
): { binding: any; externalUrl?: string } {
  const workerConfig = config.workers?.[workerName];
  const serviceConfig = workerConfig?.services?.find(s => s.binding === bindingName);

  const binding = env[bindingName];
  const externalUrl = serviceConfig?.external_url;

  return { binding, externalUrl };
}

// Service/Handler discovery result interface
export interface ServiceDiscoveryResult {
  assignedHandlers: string[];
  assignedServices: Array<{ binding: string; service: string; external_url?: string }>;
  initializedHandlers: string[];
  availableServiceBindings: Array<{ binding: string; service: string; external_url?: string }>;
  configMatchesReality: boolean;
  allWorkers: Record<string, { handlers: string[]; services: Array<{ binding: string; service: string; external_url?: string }> }>;
}

// Get service/handler discovery information for current worker
export function getServiceDiscovery(
  env: any,
  config: AppConfig,
  workerName: string,
  workerRegistry: any
): ServiceDiscoveryResult {
  const routerWorkerName = getRouterWorkerName(config);
  const workerConfig = config.workers?.[workerName];

  const assignedHandlers = workerConfig?.handlers || [];
  const assignedServices = workerConfig?.services || [];

  // Get actually initialized handlers from the registry
  const initializedHandlers = workerRegistry.getHandlers
    ? workerRegistry.getHandlers(workerName).map((h: any) => h.name)
    : workerRegistry.getHandlerNames
      ? workerRegistry.getHandlerNames(workerName)
      : [];

  const isRouterWorker = workerName === routerWorkerName;

  let availableServiceBindings: Array<{ binding: string; service: string; external_url?: string }> = [];

  if (isRouterWorker) {
    // Router worker: include all assigned services that have bindings available
    availableServiceBindings = assignedServices
      .filter(service => {
        if (service.external_url) return true;
        return env[service.binding];
      })
      .map(service => ({
        binding: service.binding,
        service: service.service,
        external_url: service.external_url
      }));
  } else {
    // Non-router workers: only include router service binding and external services
    availableServiceBindings = assignedServices
      .filter(service => {
        if (service.external_url) return true;
        return service.service === routerWorkerName && env[service.binding];
      })
      .map(service => ({
        binding: service.binding,
        service: service.service,
        external_url: service.external_url
      }));
  }

  const configMatchesReality =
    assignedHandlers.every(handler => initializedHandlers.includes(handler)) &&
    assignedServices.every(service => {
      if (service.external_url) return true;
      return env[service.binding];
    });

  const allWorkers: Record<string, { handlers: string[]; services: Array<{ binding: string; service: string; external_url?: string }> }> = {};

  for (const [name, worker] of Object.entries(config.workers || {})) {
    allWorkers[name] = {
      handlers: worker.handlers || [],
      services: worker.services || []
    };
  }

  // Add router to allWorkers if it exists
  if (config.router) {
    allWorkers[routerWorkerName] = {
      handlers: [],
      services: config.router.services || []
    };
  }

  return {
    assignedHandlers,
    assignedServices,
    initializedHandlers,
    availableServiceBindings,
    configMatchesReality,
    allWorkers
  };
}

// Get fetch instance (handler or service) for a given target — auto-detect type
export function getFetchInstance(
  target: string,
  discovery: ServiceDiscoveryResult,
  env: any
): { type: 'handler' | 'service'; name: string; handler?: any; binding?: any; external_url?: string } | null {
  // First check if it's a handler on current worker
  if (discovery.initializedHandlers.includes(target)) {
    return { type: 'handler', name: target };
  }

  // Check if it's a handler on another worker
  for (const [workerName, worker] of Object.entries(discovery.allWorkers)) {
    if (worker.handlers.includes(target)) {
      return { type: 'handler', name: target };
    }
  }

  // Check if it's a service binding on current worker (assigned services)
  const service = discovery.assignedServices.find(s => s.service === target);
  if (service) {
    const binding = service.external_url ? null : env[service.binding];
    return {
      type: 'service',
      name: target,
      binding,
      external_url: service.external_url
    };
  }

  // Check if it's a service binding on router (for non-router workers)
  const routerWorkerName = Object.keys(discovery.allWorkers).find(k => {
    const workerData = discovery.allWorkers[k];
    // Identify the router by checking if it has no handlers (routers don't have handlers)
    return workerData && workerData.handlers.length === 0 && workerData.services.length > 0;
  }) || '';

  const routerWorker = discovery.allWorkers[routerWorkerName];
  if (routerWorker) {
    const routerService = routerWorker.services.find(s => s.service === target);
    if (routerService) {
      return {
        type: 'service',
        name: target,
        binding: null,
        external_url: routerService.external_url
      };
    }
  }

  return null;
}
