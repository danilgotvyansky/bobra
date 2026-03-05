import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { Pool } from 'pg';
import { getLogger } from '../logging/logger';
import type { D1Database, Hyperdrive } from '@cloudflare/workers-types';

export interface AppEnvBindings {
  D1?: D1Database;
  POSTGRES?: { connectionString: string };
  DB_ENGINE?: string;
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  DEPLOYMENT_CONTEXT?: 'cloudflare' | 'self-hosted';
  PGEDGE_ENABLED?: boolean | string;
  PGEDGE_LOCATIONS?: string;
  [key: string]: any;
}

type DrizzleSchema = Record<string, unknown>;

export type DrizzleD1Client<S extends DrizzleSchema = DrizzleSchema> = ReturnType<typeof drizzleD1<S>>;
export type DrizzlePgClient<S extends DrizzleSchema = DrizzleSchema> = ReturnType<typeof drizzlePg<S>>;

/**
 * Database context for operations
 */
export interface DatabaseContext<S extends DrizzleSchema = DrizzleSchema> {
  type: 'postgres' | 'd1-sqlite';
  db: DrizzleD1Client<S> | DrizzlePgClient<S>;
}

export type PgEdgeRouter = (locations: string[], cfContinentStr?: string, cfInfo?: any) => string;

export interface DbContextOptions {
  cfInfo?: any;
  pgEdgeRouter?: PgEdgeRouter;
}

/**
 * Get database context based on environment.
 */
export function getDatabaseContext<S extends DrizzleSchema>(
  env: AppEnvBindings,
  schema: S,
  optionsOrCfInfo?: any | DbContextOptions
): DatabaseContext<S> {
  const options = getNormalizedDbContextOptions(optionsOrCfInfo);
  const dbEngine = env.DB_ENGINE || 'auto-detect';

  if (dbEngine === 'postgres' && hasPostgresBindings(env)) {
    return { type: 'postgres', db: getDb(env, schema, options) };
  }

  if (dbEngine === 'd1-sqlite' && env.D1) {
    return { type: 'd1-sqlite', db: getDb(env, schema, options) };
  }

  // Auto-detect fallback
  if (hasPostgresBindings(env)) {
    return { type: 'postgres', db: getDb(env, schema, options) };
  }

  if (env.D1) {
    return { type: 'd1-sqlite', db: getDb(env, schema, options) };
  }

  throw new Error('No supported database configuration found');
}

/**
 * cfInfo for backward compatibility
 */
export function getNormalizedDbContextOptions(optionsOrCfInfo?: any): DbContextOptions {
  if (!optionsOrCfInfo) return {};
  if (typeof optionsOrCfInfo === 'object' && ('pgEdgeRouter' in optionsOrCfInfo || 'cfInfo' in optionsOrCfInfo || Object.keys(optionsOrCfInfo).length === 0)) {
    return optionsOrCfInfo as DbContextOptions;
  }
  return { cfInfo: optionsOrCfInfo };
}

/**
 * Check if database context is SQLite
 */
export function isSQLite(ctx: DatabaseContext): boolean {
  return ctx.type === 'd1-sqlite';
}

/**
 * Returns a Drizzle client using either D1 or PostgreSQL.
 * Consumers pass their own Drizzle schema for typed queries.
 */
export const defaultPgEdgeRouter: PgEdgeRouter = (locations: string[], cfContinentStr?: string) => {
  let targetLocation = locations[0]!;

  if (cfContinentStr === 'EU' && locations.includes('eu')) {
    targetLocation = 'eu';
  } else if (cfContinentStr === 'NA' && locations.includes('us')) {
    targetLocation = 'us';
  } else if (locations.includes('eu')) {
    // Default to EU when continent is unknown
    targetLocation = 'eu';
  }

  return targetLocation;
};

/**
 * Returns a Drizzle client using either D1 or PostgreSQL.
 * Consumers pass their own Drizzle schema for typed queries.
 */
export function getDb<S extends DrizzleSchema>(
  env: AppEnvBindings,
  schema: S,
  optionsOrCfInfo?: any | DbContextOptions
): DrizzleD1Client<S> | DrizzlePgClient<S> {
  const options = getNormalizedDbContextOptions(optionsOrCfInfo);
  const cfInfo = options.cfInfo;
  const pgEdgeRouter = options.pgEdgeRouter || defaultPgEdgeRouter;

  const dbEngine = env.DB_ENGINE || 'auto-detect';

  const logger = getLogger();

  // Resolve continent: prefer direct cf object, fall back to router-forwarded header
  const continent = cfInfo?.continent
    || (env as any).__cfContinent  // allow explicit override
    || undefined;

  logger.debug('[getDb] Starting DB resolution', {
    dbEngine,
    hasPOSTGRES: !!env.POSTGRES?.connectionString,
    hasD1: !!env.D1,
    PGEDGE_ENABLED: env.PGEDGE_ENABLED,
    PGEDGE_LOCATIONS: env.PGEDGE_LOCATIONS,
    cfContinent: continent,
    cfColo: cfInfo?.colo,
  });

  if (dbEngine === 'postgres' || (dbEngine === 'auto-detect' && hasPostgresBindings(env))) {
    const locations = getPgEdgeLocations(env);

    if (locations.length > 1) {
      const cfContinentStr = (continent || '').toUpperCase();
      const targetLocation = pgEdgeRouter(locations, cfContinentStr, cfInfo);

      // Order locations so target goes first
      const orderedLocations = [
        targetLocation,
        ...locations.filter(loc => loc !== targetLocation)
      ];

      const connectionStrings: string[] = [];
      for (const loc of orderedLocations) {
        const bindingName = `POSTGRES_${loc.toUpperCase()}`;
        const binding = env[bindingName];
        if (binding?.connectionString) {
          connectionStrings.push(binding.connectionString);
        }
      }

      // Use the closest location's Hyperdrive connection directly
      if (connectionStrings.length > 0) {
        logger.debug('[getDb] Using closest pgEdge location', { targetLocation });
        return createPgDrizzleClient(connectionStrings[0]!, schema);
      } else {
        logger.warn('[getDb] pgEdge enabled but no connection strings found from bindings', { orderedLocations });
      }
    }

    if (env.POSTGRES?.connectionString) {
      logger.debug('[getDb] Using single POSTGRES binding');
      return createPgDrizzleClient(env.POSTGRES.connectionString, schema);
    }

    // Look for any binding if locations were exactly 1
    if (locations.length === 1) {
      const bindingName = `POSTGRES_${locations[0]!.toUpperCase()}`;
      logger.debug('[getDb] Single pgEdge location', { bindingName, hasBinding: !!env[bindingName]?.connectionString });
      if (env[bindingName]?.connectionString) {
        return createPgDrizzleClient(env[bindingName].connectionString, schema);
      }
    }

    logger.error('[getDb] No POSTGRES binding found', undefined, {
      locationsCount: locations.length,
      hasFallbackPOSTGRES: !!env.POSTGRES?.connectionString,
      envKeys: Object.keys(env).filter(k => k.startsWith('POSTGRES') || k.startsWith('PGEDGE') || k === 'DB_ENGINE'),
    });
    throw new Error("POSTGRES binding with connectionString is required when DB_ENGINE is set to 'postgres'");
  }

  if (dbEngine === 'd1-sqlite' || (dbEngine === 'auto-detect' && env.D1)) {
    if (!env.D1) {
      throw new Error("D1 binding is required when DB_ENGINE is set to 'd1-sqlite'");
    }
    return createD1DrizzleClient(env.D1, schema);
  }

  throw new Error("No database binding found: bind either POSTGRES or D1 in your worker");
}

export function createD1DrizzleClient<S extends DrizzleSchema>(d1: D1Database, schema: S): DrizzleD1Client<S> {
  return drizzleD1(d1, { schema });
}

export function createPgDrizzleClient<S extends DrizzleSchema>(connectionString: string, schema: S): DrizzlePgClient<S> {
  try {
    const pool = new Pool({ connectionString });
    const drizzleClient = drizzlePg(pool, { schema });
    return drizzleClient;
  } catch (error) {
    getLogger().error('[createPgDrizzleClient] Error creating PostgreSQL client:', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export function getPgEdgeLocations(env: AppEnvBindings): string[] {
  const isPgEdgeEnabled = env.PGEDGE_ENABLED === true || env.PGEDGE_ENABLED === 'true';
  if (!isPgEdgeEnabled) return [];

  let pgedgeLocations: string[] = [];
  if (env.PGEDGE_LOCATIONS) {
    try {
      const parsed = typeof env.PGEDGE_LOCATIONS === 'string'
        ? JSON.parse(env.PGEDGE_LOCATIONS)
        : env.PGEDGE_LOCATIONS;

      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        pgedgeLocations = parsed.map(item => item.toLowerCase());
      } else {
        getLogger().warn('PGEDGE_LOCATIONS must be an array of strings');
      }
    } catch (e) {
      getLogger().warn('Failed to parse PGEDGE_LOCATIONS', e instanceof Error ? e : new Error(String(e)));
    }
  }
  return pgedgeLocations;
}

export function hasPostgresBindings(env: AppEnvBindings): boolean {
  if (env.POSTGRES?.connectionString) return true;

  const locations = getPgEdgeLocations(env);
  if (locations.length > 0) {
    return locations.some(loc => env[`POSTGRES_${loc.toUpperCase()}`]?.connectionString);
  }
  return false;
}
