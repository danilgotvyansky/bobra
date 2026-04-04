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
export type PostgresBindingRole = string;

export interface DbContextOptions {
  cfInfo?: any;
  pgEdgeRouter?: PgEdgeRouter;
  postgresBindingRole?: PostgresBindingRole;
}

interface ResolvedPostgresBinding {
  bindingName: string;
  connectionString: string;
}

function normalizePostgresBindingRole(role?: PostgresBindingRole): string | undefined {
  const trimmedRole = role?.trim();
  if (!trimmedRole) return undefined;

  const normalizedRole = trimmedRole.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!normalizedRole || normalizedRole === 'DEFAULT') return undefined;
  return normalizedRole;
}

function getPostgresLocationBindingCandidates(location: string, role?: PostgresBindingRole): string[] {
  const normalizedLocation = location.toUpperCase();
  const normalizedRole = normalizePostgresBindingRole(role);

  if (!normalizedRole) {
    return [
      `POSTGRES_${normalizedLocation}`,
      `POSTGRES_${normalizedLocation}_DEFAULT`,
    ];
  }

  return [
    `POSTGRES_${normalizedLocation}_${normalizedRole}`,
    `POSTGRES_${normalizedLocation}`,
    `POSTGRES_${normalizedLocation}_DEFAULT`,
  ];
}

function getSinglePostgresBindingCandidates(role?: PostgresBindingRole): string[] {
  const normalizedRole = normalizePostgresBindingRole(role);

  if (!normalizedRole) {
    return ['POSTGRES', 'POSTGRES_DEFAULT'];
  }

  return [`POSTGRES_${normalizedRole}`, 'POSTGRES', 'POSTGRES_DEFAULT'];
}

function resolvePostgresBindingByCandidates(
  env: AppEnvBindings,
  candidateBindingNames: string[]
): ResolvedPostgresBinding | undefined {
  for (const bindingName of candidateBindingNames) {
    const binding = env[bindingName];
    if (binding?.connectionString && typeof binding.connectionString === 'string') {
      return {
        bindingName,
        connectionString: binding.connectionString,
      };
    }
  }

  return undefined;
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

  if (dbEngine === 'postgres' && hasPostgresBindings(env, options.postgresBindingRole)) {
    return { type: 'postgres', db: getDb(env, schema, options) };
  }

  if (dbEngine === 'd1-sqlite' && env.D1) {
    return { type: 'd1-sqlite', db: getDb(env, schema, options) };
  }

  // Auto-detect fallback
  if (hasPostgresBindings(env, options.postgresBindingRole)) {
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
  if (
    typeof optionsOrCfInfo === 'object' && (
      'pgEdgeRouter' in optionsOrCfInfo
      || 'cfInfo' in optionsOrCfInfo
      || 'postgresBindingRole' in optionsOrCfInfo
      || Object.keys(optionsOrCfInfo).length === 0
    )
  ) {
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
  const postgresBindingRole = options.postgresBindingRole;
  const normalizedPostgresBindingRole = normalizePostgresBindingRole(postgresBindingRole);

  const dbEngine = env.DB_ENGINE || 'auto-detect';

  const logger = getLogger();

  // Resolve continent: prefer direct cf object, fall back to router-forwarded header
  const continent = cfInfo?.continent
    || (env as any).__cfContinent  // allow explicit override
    || undefined;

  if (env.PGEDGE_DEBUG_LOGGING) {
    logger.debug('[getDb] Starting DB resolution', {
      dbEngine,
      hasPOSTGRES: !!env.POSTGRES?.connectionString,
      hasD1: !!env.D1,
      PGEDGE_ENABLED: env.PGEDGE_ENABLED,
      PGEDGE_LOCATIONS: env.PGEDGE_LOCATIONS,
      postgresBindingRole: normalizedPostgresBindingRole || 'DEFAULT',
      cfContinent: continent,
      cfColo: cfInfo?.colo,
    });
  }

  if (dbEngine === 'postgres' || (dbEngine === 'auto-detect' && hasPostgresBindings(env))) {
    const locations = getPgEdgeLocations(env);

    if (locations.length > 0) {
      let orderedLocations = [...locations];
      let targetLocation: string | undefined;

      if (locations.length > 1) {
        const cfContinentStr = (continent || '').toUpperCase();
        targetLocation = pgEdgeRouter(locations, cfContinentStr, cfInfo);

        // Order locations so target goes first
        orderedLocations = [
          targetLocation,
          ...locations.filter(loc => loc !== targetLocation)
        ];
      }

      for (const loc of orderedLocations) {
        const resolved = resolvePostgresBindingByCandidates(
          env,
          getPostgresLocationBindingCandidates(loc, postgresBindingRole)
        );

        if (resolved) {
          if (env.PGEDGE_DEBUG_LOGGING) {
            logger.debug('[getDb] Using pgEdge binding', {
              targetLocation,
              selectedLocation: loc,
              selectedBinding: resolved.bindingName,
              postgresBindingRole: normalizedPostgresBindingRole || 'DEFAULT',
            });
          }

          return createPgDrizzleClient(resolved.connectionString, schema);
        }
      }

      logger.warn('[getDb] pgEdge enabled but no matching POSTGRES bindings found', {
        orderedLocations,
        postgresBindingRole: normalizedPostgresBindingRole || 'DEFAULT',
      });
    }

    const singleResolved = resolvePostgresBindingByCandidates(
      env,
      getSinglePostgresBindingCandidates(postgresBindingRole)
    );

    if (singleResolved) {
      if (env.PGEDGE_DEBUG_LOGGING) {
        logger.debug('[getDb] Using single POSTGRES binding', {
          selectedBinding: singleResolved.bindingName,
          postgresBindingRole: normalizedPostgresBindingRole || 'DEFAULT',
        });
      }

      return createPgDrizzleClient(singleResolved.connectionString, schema);
    }

    logger.error('[getDb] No POSTGRES binding found', undefined, {
      locationsCount: locations.length,
      hasFallbackPOSTGRES: !!resolvePostgresBindingByCandidates(
        env,
        getSinglePostgresBindingCandidates(postgresBindingRole)
      ),
      postgresBindingRole: normalizedPostgresBindingRole || 'DEFAULT',
      envKeys: Object.keys(env).filter(k => k.startsWith('POSTGRES') || k.startsWith('PGEDGE') || k === 'DB_ENGINE'),
    });
    throw new Error("POSTGRES binding with connectionString is required when DB_ENGINE is set to 'postgres'. If using roles, ensure role-specific bindings exist or fallback POSTGRES bindings are configured.");
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

export function hasPostgresBindings(env: AppEnvBindings, role?: PostgresBindingRole): boolean {
  if (resolvePostgresBindingByCandidates(env, getSinglePostgresBindingCandidates(role))) return true;

  const locations = getPgEdgeLocations(env);
  if (locations.length > 0) {
    return locations.some(loc =>
      !!resolvePostgresBindingByCandidates(env, getPostgresLocationBindingCandidates(loc, role))
    );
  }
  return false;
}
