/**
 * Environment Variable Resolver
 * 
 * Resolves $VAR and ${VAR} patterns in configuration.
 * 
 * Usage:
 *   // For workers (runtime)
 *   const resolved = resolveConfig(config, env, new Map());
 * 
 *   // For Node.js scripts
 *   import { loadEnvFiles } from './env-files';
 *   const envMap = loadEnvFiles();
 *   const resolved = resolveConfig(config, process.env, envMap);
 */

/**
 * Parse .dev.vars file format (key=value, one per line, shell-style comments)
 * Returns Map for efficient lookup
 */
export function parseDevVars(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  const lines = content.split('\n');

  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parse key=value
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }

    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();

    // Remove surrounding quotes if present (handle "value" or 'value')
    let finalValue = value;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      finalValue = value.slice(1, -1);
    }

    if (key) {
      vars.set(key, finalValue);
    }
  }

  return vars;
}

/**
 * Detect if value contains variable pattern $VAR or ${VAR}
 */
export function hasVariablePattern(value: string): boolean {
  return /\$\{?[A-Z_][A-Z0-9_]*\}?/i.test(value);
}

/**
 * Extract variable names from value (handles $VAR and ${VAR})
 * Returns array of variable names (without $ or ${})
 */
export function extractVariableNames(value: string): string[] {
  const pattern = /\$\{?([A-Z_][A-Z0-9_]*)\}?/gi;
  const matches = Array.from(value.matchAll(pattern));
  return matches.map(m => m[1]!).filter(Boolean) as string[];
}

/**
 * Resolve a single variable value using priority chain
 * Priority: env → devVars → undefined (original value is kept)
 */
export function resolveVariable(
  varName: string,
  env: Record<string, any>,
  devVars: Map<string, string>
): string | undefined {
  // 1. Check env bindings (Cloudflare secrets at runtime)
  if (env[varName] !== undefined && env[varName] !== null) {
    return String(env[varName]);
  }

  // 2. Check .dev.vars (local development)
  if (devVars.has(varName)) {
    return devVars.get(varName);
  }

  // 3. Not found
  return undefined;
}

/**
 * Resolve all variable patterns in a string value
 * Replaces $VAR or ${VAR} with resolved values, leaves unresolved patterns as-is
 */
export function resolveStringValue(
  value: string,
  env: Record<string, any>,
  devVars: Map<string, string>
): string {
  // Pattern matches both $VAR and ${VAR}
  return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, varName) => {
    const resolved = resolveVariable(varName, env, devVars);
    return resolved !== undefined ? resolved : match; // Keep original if not resolved
  });
}

/**
 * Recursively resolve variables in any config value
 * Handles: strings, numbers, booleans, objects, arrays
 */
export function resolveValue(
  value: any,
  env: Record<string, any>,
  devVars: Map<string, string>
): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return resolveStringValue(value, env, devVars);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value; // Numbers and booleans don't contain variables
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveValue(item, env, devVars));
  }

  if (typeof value === 'object') {
    const resolved: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      resolved[key] = resolveValue(val, env, devVars);
    }
    return resolved;
  }

  return value;
}

/**
 * Main resolver: Process entire config object with variable resolution
 * Returns new config object with all variables resolved
 * 
 * @param config - Configuration object to resolve
 * @param env - Environment variables (process.env or worker env)
 * @param devVars - Optional file-based vars (for Node.js scripts only, defaults to empty)
 */
export function resolveConfig(
  config: Record<string, any>,
  env: Record<string, any>,
  devVars: Map<string, string> = new Map()
): Record<string, any> {
  return resolveValue(config, env, devVars);
}
