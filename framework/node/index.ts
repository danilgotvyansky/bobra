/**
 * Node.js-only: Load .dev.vars and .env files from disk.
 *
 * This module intentionally uses `fs`, `path`, and `process` and must NOT be
 * imported from modules that run inside Cloudflare Workers. It lives in
 * the `node/` directory to prevent accidental inclusion in CF Workers bundles.
 */

import * as fs from 'fs';
import * as path from 'path';
export * from './generate-wrangler-config';
import { parseDevVars } from '../core/env-resolver';

/**
 * Load .dev.vars and .env files for Node.js scripts.
 *
 * Within the returned Map, values from .dev.vars override values from .env.
 * When used with `resolveConfig(config, process.env, envMap)`, the runtime
 * environment (`env` / `process.env`) has higher priority than values from
 * this Map.
 */
export function loadEnvFiles(configDir?: string): Map<string, string> {
  const vars = new Map<string, string>();
  const baseDir = configDir || process.cwd();

  // Try to load .env first (lower priority)
  const envPath = path.join(baseDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const parsed = parseDevVars(content);
    parsed.forEach((value, key) => vars.set(key, value));
  }

  // Then load .dev.vars (higher priority, overwrites .env)
  const devVarsPath = path.join(baseDir, '.dev.vars');
  if (fs.existsSync(devVarsPath)) {
    const content = fs.readFileSync(devVarsPath, 'utf-8');
    const parsed = parseDevVars(content);
    parsed.forEach((value, key) => vars.set(key, value));
  }

  return vars;
}
