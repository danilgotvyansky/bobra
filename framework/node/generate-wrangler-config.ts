#!/usr/bin/env tsx

/**
 * Generate wrangler.jsonc from config.yml for generic Bobra worker
 * 
 * This script reads a YAML configuration file and generates a wrangler.jsonc
 * file with the appropriate environment variables and settings.
 * 
 * Usage:
 *   npx tsx scripts/generate-wrangler-config.ts [config-file] [output-file] [worker-type] [worker-name]
 */
import * as fs from 'fs';
import { load, dump } from 'js-yaml';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  type AppConfig,
  serviceToBindingName,
  getDatabaseBinding,
  getWorkerQueueBindings,
  getWorkerDbEngine
} from '../core/config';
import { JSONValue } from 'hono/utils/types';
import { gzipSync } from 'zlib';

interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  assets?: {
    directory?: string;
    binding?: string;
    include?: string[];
    exclude?: string[];
    run_worker_first?: boolean | string[];
    html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
    not_found_handling?: 'single-page-application' | '404-page' | 'none';
  };
  dev?: {
    port: number;
    ip: string;
    inspector_port?: number;
  };
  vars: {
    CONFIG_CONTENT?: string;
    DB_ENGINE: string;
    [key: string]: string | number | boolean | JSONValue | undefined;
  };
  migrations?: Array<{
    tag: string;
    new_classes?: string[];
    renamed_classes?: Array<{ from: string; to: string }>;
    deleted_classes?: string[];
  }>;
  durable_objects?: {
    bindings: Array<{
      name: string;
      class_name: string;
      script_name?: string;
    }>;
  };
  services?: Array<{
    binding: string;
    service: string;
  }>;
  hyperdrive?: Array<{
    binding: string;
    id: string;
    localConnectionString: string;
  }>;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id: string;
    migrations_dir?: string;
  }>;
  queues?: {
    producers?: Array<{
      binding: string;
      queue: string;
    }>;
    consumers?: Array<{
      queue: string;
      max_batch_size?: number;
      max_batch_timeout?: number;
      max_retries?: number;
      dead_letter_queue?: string;
      max_concurrency?: number;
      retry_delay?: number;
    }>;
  };
  kv_namespaces?: Array<{
    binding: string;
    id?: string;
    preview_id?: string;
  }>;
  routes?: Array<{
    pattern: string;
    custom_domain?: boolean;
    zone_id?: string;
    zone_name?: string;
  }>;
  workers_dev?: boolean;
  observability?: {
    logs?: {
      enabled?: boolean;
    };
  };
}

function normalizePathValue(p?: string): string {
  let v = p || '/';
  if (!v.startsWith('/')) v = '/' + v;
  if (v.length > 1) v = v.replace(/\/+$/, '');
  return v;
}

export function generateWranglerConfig(config: AppConfig, workerType: string, workerName: string): WranglerConfig {
  const configYaml = dump(config);
  const compressed = gzipSync(configYaml, { mtime: 0 } as any);
  const configContent = compressed.toString('base64');

  let wranglerConfig: WranglerConfig;

  if (workerType === 'router') {
    const routerConfig = config.router;
    wranglerConfig = {
      name: routerConfig?.name || "example-app-router-worker",
      main: routerConfig?.main || "src/index.ts",
      compatibility_date: "2025-02-14",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        CONFIG_CONTENT: configContent,
        DB_ENGINE: config.db_engine,
        PGEDGE_ENABLED: config.pgEdge?.enabled ?? false,
        PGEDGE_LOCATIONS: JSON.stringify(config.pgEdge?.locations || []),
        ...(config.deployment_context && { DEPLOYMENT_CONTEXT: config.deployment_context }),
        ...config.vars,
        ...routerConfig?.vars
      },
      observability: {
        logs: {
          enabled: routerConfig?.observability?.logs?.enabled || false
        }
      }
    };

    const rcAny = routerConfig as any;
    const assetsDirectory: string | undefined = rcAny?.assets?.directory || 'public';
    let runWorkerFirstConfig: boolean | string[] | undefined = rcAny?.assets?.run_worker_first;

    const patterns = new Set<string>();

    if (Array.isArray(runWorkerFirstConfig)) {
      runWorkerFirstConfig.forEach(p => patterns.add(p));
    }

    if (runWorkerFirstConfig !== true && runWorkerFirstConfig !== false) {
      if (Array.isArray(routerConfig?.routes)) {
        for (const r of routerConfig.routes) {
          if (!r?.path || typeof r.path !== 'string') continue;
          const raw = r.path.trim();
          if (!raw.startsWith('/')) continue;
          const noStar = raw.replace(/\*+.*/, '');
          const segs = noStar.split('/').filter(Boolean);
          if (segs.length === 0) continue;
          const base = '/' + segs[0];
          patterns.add(`${base}/*`);
        }
      }
      const routerBase = normalizePathValue(routerConfig?.base_path);
      const routerPrefix = routerBase === '/' ? '' : routerBase;
      patterns.add(`${routerPrefix}/router/*`);
    }

    let runWorkerFirst: boolean | string[] | undefined;
    if (typeof runWorkerFirstConfig === 'boolean') {
      runWorkerFirst = runWorkerFirstConfig;
    } else {
      runWorkerFirst = Array.from(patterns);
    }
    const notFoundHandling: 'single-page-application' | '404-page' | 'none' | undefined = rcAny?.assets?.not_found_handling || 'single-page-application';
    const htmlHandling: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none' | undefined = rcAny?.assets?.html_handling;
    wranglerConfig.assets = {
      directory: assetsDirectory,
      binding: 'ASSETS',
      run_worker_first: runWorkerFirst,
      not_found_handling: notFoundHandling,
      ...(htmlHandling ? { html_handling: htmlHandling } : {})
    };

    if (routerConfig?.port) {
      wranglerConfig.dev = {
        port: routerConfig.port,
        ip: "localhost"
      };
      if (routerConfig.inspector_port !== undefined && routerConfig.inspector_port !== null) {
        wranglerConfig.dev.inspector_port = routerConfig.inspector_port;
      }
    }

    if (routerConfig?.routes) {
      const services = new Set<string>();
      routerConfig.routes.forEach(route => services.add(route.service));

      wranglerConfig.services = Array.from(services).map(service => ({
        binding: serviceToBindingName(service),
        service: service
      }));
    }

    if (routerConfig?.services) {
      const additionalServices = routerConfig.services.filter(service => !service.external_url);
      if (additionalServices.length > 0) {
        if (!wranglerConfig.services) {
          wranglerConfig.services = [];
        }
        wranglerConfig.services.push(...additionalServices.map(service => ({
          binding: service.binding,
          service: service.service
        })));
      }
    }

    if (routerConfig?.kv_namespaces?.length) {
      wranglerConfig.kv_namespaces = routerConfig.kv_namespaces;
    }

    if (routerConfig?.cf_routes) {
      wranglerConfig.routes = routerConfig.cf_routes;
      wranglerConfig.workers_dev = false;
    }
  } else {
    // Worker configuration
    const workerConfig = config.workers?.[workerName];
    wranglerConfig = {
      name: workerConfig?.name || workerName,
      main: workerConfig?.main || "src/index.ts",
      compatibility_date: "2025-02-14",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        CONFIG_CONTENT: configContent,
        DB_ENGINE: getWorkerDbEngine(config, workerName),
        PGEDGE_ENABLED: config.pgEdge?.enabled ?? false,
        PGEDGE_LOCATIONS: JSON.stringify(config.pgEdge?.locations || []),
        ...(config.deployment_context && { DEPLOYMENT_CONTEXT: config.deployment_context }),
        ...config.vars,
        ...workerConfig?.vars
      },
      observability: {
        logs: {
          enabled: workerConfig?.observability?.logs?.enabled || false
        }
      }
    };

    if (workerConfig?.port) {
      wranglerConfig.dev = {
        port: workerConfig.port,
        ip: "localhost"
      };
      if (workerConfig.inspector_port !== undefined && workerConfig.inspector_port !== null) {
        wranglerConfig.dev.inspector_port = workerConfig.inspector_port;
      }
    }

    const workerConfigAny = workerConfig as any;
    if (workerConfigAny?.assets) {
      const assetsDirectory: string | undefined = workerConfigAny?.assets?.directory || 'public';
      let runWorkerFirstConfig: boolean | string[] | undefined = workerConfigAny?.assets?.run_worker_first;

      const patterns = new Set<string>();
      if (Array.isArray(runWorkerFirstConfig)) {
        runWorkerFirstConfig.forEach(p => patterns.add(p));
      }

      let runWorkerFirst: boolean | string[] | undefined;
      if (typeof runWorkerFirstConfig === 'boolean') {
        runWorkerFirst = runWorkerFirstConfig;
      } else if (patterns.size > 0) {
        runWorkerFirst = Array.from(patterns);
      }

      const notFoundHandling: 'single-page-application' | '404-page' | 'none' | undefined = workerConfigAny?.assets?.not_found_handling || 'single-page-application';
      const htmlHandling: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none' | undefined = workerConfigAny?.assets?.html_handling;

      wranglerConfig.assets = {
        directory: assetsDirectory,
        binding: 'ASSETS',
        run_worker_first: runWorkerFirst,
        not_found_handling: notFoundHandling,
        ...(htmlHandling ? { html_handling: htmlHandling } : {})
      };
    }

    if (workerConfig?.database) {
      try {
        const dbBinding = getDatabaseBinding(config, workerName);
        if (dbBinding.type === 'hyperdrive') {
          const cfg = dbBinding.config as any;
          const isSingle = typeof cfg === 'object' && cfg !== null && 'id' in cfg && 'binding' in cfg;

          if (isSingle) {
            // It's a single HyperdriveConfig
            wranglerConfig.hyperdrive = [{
              binding: cfg.binding,
              id: cfg.id,
              localConnectionString: cfg.localConnectionString
            }];
          } else if (typeof cfg === 'object' && cfg !== null) {
            // It's a Record<string, HyperdriveConfig>
            wranglerConfig.hyperdrive = [];
            for (const [key, hdConfig] of Object.entries(cfg as Record<string, any>)) {
              if (typeof hdConfig !== 'object' || hdConfig === null || !('id' in hdConfig) || !('binding' in hdConfig)) {
                throw new Error(`Invalid Hyperdrive configuration for key "${key}" in worker "${workerName}". Expected 'binding' and 'id'.`);
              }
              wranglerConfig.hyperdrive.push({
                binding: hdConfig.binding,
                id: hdConfig.id,
                localConnectionString: hdConfig.localConnectionString
              });
            }
            if (wranglerConfig.hyperdrive.length === 0) {
              throw new Error(`Hyperdrive configuration for worker "${workerName}" cannot be an empty object.`);
            }
          } else {
            throw new Error(`Invalid Hyperdrive configuration format for worker "${workerName}". Expected an object with 'id' and 'binding', or a record of such objects.`);
          }
        } else if (dbBinding.type === 'd1') {
          wranglerConfig.d1_databases = [{
            binding: dbBinding.config.binding,
            database_name: dbBinding.config.database_name,
            database_id: dbBinding.config.database_id,
            migrations_dir: dbBinding.config.migrations_dir
          }];
        }
      } catch (error) {
        console.warn(`Warning: Could not configure database binding for ${workerName}:`, error instanceof Error ? error.message : error);
      }
    }

    if (workerConfig?.services && !workerConfig?.services.some(s => s.external_url)) {
      wranglerConfig.services = workerConfig.services;
    }

    if (workerConfig?.kv_namespaces?.length) {
      wranglerConfig.kv_namespaces = workerConfig.kv_namespaces;
    }

    if (workerConfig?.durable_objects?.length) {
      wranglerConfig.durable_objects = {
        bindings: workerConfig.durable_objects.map((dob) => ({
          name: dob.binding,
          class_name: dob.class_name,
          ...(dob.script_name ? { script_name: dob.script_name } : {})
        }))
      };

      const doClassNames = workerConfig.durable_objects.map(d => d.class_name).filter(Boolean);
      if (doClassNames.length > 0) {
        if (!wranglerConfig.migrations) {
          wranglerConfig.migrations = [];
        }
        const hasDoMigration = wranglerConfig.migrations.some(m => (m.new_classes?.length ?? 0) > 0);
        if (!hasDoMigration) {
          wranglerConfig.migrations.push({
            tag: 'durable-objects-v1',
            new_classes: doClassNames
          });
        }
      }
    }

    const queueBindings = getWorkerQueueBindings(config, workerName);
    if (queueBindings.producers.length > 0 || queueBindings.consumers.length > 0) {
      wranglerConfig.queues = {};

      if (queueBindings.producers.length > 0) {
        wranglerConfig.queues.producers = queueBindings.producers;
      }

      if (queueBindings.consumers.length > 0) {
        wranglerConfig.queues.consumers = queueBindings.consumers;
      }
    }

    if (workerConfig?.cf_routes) {
      wranglerConfig.routes = workerConfig.cf_routes;
      wranglerConfig.workers_dev = false;
    } else {
      wranglerConfig.workers_dev = false;
    }
  }

  return wranglerConfig;
}

function copyDevVarsToWorker(workerDir: string, repoRoot: string) {
  const sourceDevVars = path.join(repoRoot, '.dev.vars');
  const targetDevVars = path.join(workerDir, '.dev.vars');

  if (fs.existsSync(sourceDevVars)) {
    try {
      fs.copyFileSync(sourceDevVars, targetDevVars);
      console.log(`   ✓ Copied .dev.vars to ${path.relative(repoRoot, workerDir)}`);
    } catch (error) {
      console.warn(`   ⚠ Failed to copy .dev.vars to ${path.relative(repoRoot, workerDir)}:`, error instanceof Error ? error.message : error);
    }
  }
}

function generateHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getStoredHash(outputDir: string): string | null {
  const hashFile = path.join(outputDir, '.config', 'config-hash');
  if (fs.existsSync(hashFile)) {
    try {
      return fs.readFileSync(hashFile, 'utf8').trim();
    } catch {
      return null;
    }
  }
  return null;
}

function storeHash(outputDir: string, hash: string): void {
  const configDir = path.join(outputDir, '.config');
  const hashFile = path.join(configDir, 'config-hash');

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(hashFile, hash, 'utf8');
  } catch (error) {
    console.warn(`   ⚠ Failed to store config hash:`, error instanceof Error ? error.message : error);
  }
}

export function main() {
  const args = typeof process !== 'undefined' ? process.argv.slice(2) : [];
  const configFile = args[0] || process.env.CONFIG_PATH || 'config.yml';
  const outputFile = args[1] || 'wrangler.jsonc';
  const workerType = args[2] || 'worker';
  const workerName = args[3] || 'default-worker';

  if (!fs.existsSync(configFile)) {
    console.error(`❌ Config file not found: ${configFile}`);
    console.log(`💡 Create a config.yml file in the project root`);
    if (typeof process !== 'undefined') process.exit(1);
    return;
  }

  const repoRoot = path.dirname(path.resolve(configFile));

  try {
    const yamlContent = fs.readFileSync(configFile, 'utf8');
    const config = load(yamlContent) as AppConfig;

    if (!config.cors || !config.server) {
      throw new Error('Config must include cors and server sections');
    }

    if (!config.server.name || !config.server.version) {
      throw new Error('Server config must include name and version');
    }

    const wranglerConfig = generateWranglerConfig(config, workerType, workerName);

    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (wranglerConfig.assets?.directory) {
      try {
        const absDesired = path.resolve(process.cwd(), wranglerConfig.assets.directory);
        const relToOutput = path.relative(outputDir, absDesired) || '.';
        wranglerConfig.assets.directory = relToOutput;
      } catch { }
    }

    const outputContent = JSON.stringify(wranglerConfig, null, 2);
    const newHash = generateHash(outputContent);

    if (fs.existsSync(outputFile)) {
      const existingContent = fs.readFileSync(outputFile, 'utf8');
      const existingHash = generateHash(existingContent);
      const storedHash = getStoredHash(outputDir);

      if (existingHash === newHash && storedHash === newHash) {
        console.log(`✅ ${path.relative(repoRoot, outputFile)} is up to date`);
        return;
      }
    }

    console.log(`📝 Generating wrangler configuration...`);
    console.log(`   Config file: ${configFile}`);
    console.log(`   Output file: ${outputFile}`);
    console.log(`   Worker type: ${workerType}`);
    console.log(`   Worker name: ${workerName}`);

    fs.writeFileSync(outputFile, outputContent);

    storeHash(outputDir, newHash);
    copyDevVarsToWorker(outputDir, repoRoot);

    console.log(`✅ Generated ${outputFile} successfully`);
    console.log(`   Worker name: ${wranglerConfig.name}`);
    console.log(`   Database engine: ${getWorkerDbEngine(config, workerName)}`);
    console.log(`   CORS origins: ${config.cors.origin.length}`);
    if (config.logging?.startupVerbosity) {
      console.log(`   Startup Verbosity: ${config.logging.startupVerbosity.length > 0 ? config.logging.startupVerbosity.join(', ') : 'None'}`);
    }

    if (config.router?.routes && workerType === 'router') {
      console.log(`   Routes: ${config.router.routes.length}`);
      const services = new Set(config.router.routes.map(r => r.service));
      console.log(`   Services: ${Array.from(services).join(', ')}`);

      // Show additional service bindings info
      if (config.router.services) {
        const additionalServicesWithBindings = config.router.services.filter(s => !s.external_url);
        const additionalServicesWithExternalUrl = config.router.services.filter(s => s.external_url);
        if (additionalServicesWithBindings.length > 0) {
          console.log(`   Additional service bindings: ${additionalServicesWithBindings.map(s => s.service).join(', ')}`);
        }
        if (additionalServicesWithExternalUrl.length > 0) {
          console.log(`   Additional external services: ${additionalServicesWithExternalUrl.map(s => s.service).join(', ')}`);
        }
      }
    }

    if (workerType === 'worker') {
      const workerConfig = config.workers[workerName];

      // Show database configuration info
      if (workerConfig?.database) {
        try {
          const dbBinding = getDatabaseBinding(config, workerName);
          console.log(`   Database: ${dbBinding.type} (worker-specific)`);
          if (dbBinding.type === 'hyperdrive') {
            const cfg = dbBinding.config as any;
            const isSingle = typeof cfg === 'object' && cfg !== null && 'id' in cfg && 'binding' in cfg;

            if (isSingle) {
              console.log(`   Hyperdrive ID: ${cfg.id}`);
            } else if (typeof cfg === 'object' && cfg !== null) {
              const locations = Object.keys(cfg);
              console.log(`   Hyperdrive: multi-location (${locations.join(', ')})`);
            } else {
              console.log(`   Hyperdrive: Invalid configuration`);
            }
          } else if (dbBinding.type === 'd1') {
            console.log(`   D1 Database: ${dbBinding.config.database_name}`);
          }
        } catch (error) {
          console.log(`   Database: Configuration error`);
        }
      } else {
        console.log(`   Database: Not configured`);
      }

      // Show queue configuration info
      if (workerConfig?.queues) {
        const queueBindings = getWorkerQueueBindings(config, workerName);
        if (queueBindings.producers.length > 0) {
          console.log(`   Queue producers: ${queueBindings.producers.map(p => p.queue).join(', ')}`);
        }
        if (queueBindings.consumers.length > 0) {
          console.log(`   Queue consumers: ${queueBindings.consumers.map(c => c.queue).join(', ')}`);
        }
      }
    }

  } catch (error) {
    console.error(`❌ Failed to generate wrangler config:`, error instanceof Error ? error.message : error);
    if (typeof process !== 'undefined') process.exit(1);
  }
}

// Run main function if called directly
if (typeof require !== 'undefined' && require.main === module) {
  main();
}
