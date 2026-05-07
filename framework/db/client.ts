import { getLogger } from '../logging/logger';
import {
  buildOrderedPostgresCandidates,
  defaultPgEdgeRouter,
  formatCandidateLabel,
  getAvailablePostgresBindingsForLocation,
  getPgEdgeLocations,
  hasPostgresBindings,
  normalizePostgresBindingRole,
  resolvePgFailoverOptions,
} from './pgedge';
import { createD1DrizzleClient, createFailoverPgDrizzleClient, createPrimaryPgDrizzleClient } from './drizzle-clients';
import type {
  AppEnvBindings,
  CfInfo,
  DatabaseContext,
  DbContextOptions,
  DrizzleD1Client,
  DrizzlePgClient,
  DrizzleSchema,
} from './types';

export * from './types';
export * from './pgedge';
export * from './failover';
export * from './drizzle-clients';

export function getDatabaseContext<S extends DrizzleSchema>(
  env: AppEnvBindings,
  schema: S,
  optionsOrCfInfo?: CfInfo | DbContextOptions
): DatabaseContext<S> {
  const options = getNormalizedDbContextOptions(optionsOrCfInfo);
  const dbEngine = env.DB_ENGINE || 'auto-detect';

  if (dbEngine === 'postgres' && hasPostgresBindings(env, options.postgresBindingRole)) {
    return { type: 'postgres', db: getDb(env, schema, options) };
  }

  if (dbEngine === 'd1-sqlite' && env.D1) {
    return { type: 'd1-sqlite', db: getDb(env, schema, options) };
  }

  if (hasPostgresBindings(env, options.postgresBindingRole)) {
    return { type: 'postgres', db: getDb(env, schema, options) };
  }

  if (env.D1) {
    return { type: 'd1-sqlite', db: getDb(env, schema, options) };
  }

  throw new Error('No supported database configuration found');
}

export function getNormalizedDbContextOptions(optionsOrCfInfo?: CfInfo | DbContextOptions): DbContextOptions {
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
  return { cfInfo: optionsOrCfInfo as CfInfo };
}

export function isSQLite(ctx: DatabaseContext): boolean {
  return ctx.type === 'd1-sqlite';
}

export function isSQLiteContext<S extends DrizzleSchema>(
  ctx: DatabaseContext<S>
): ctx is { type: 'd1-sqlite'; db: DrizzleD1Client<S> } {
  return ctx.type === 'd1-sqlite';
}

export function isPostgresContext<S extends DrizzleSchema>(
  ctx: DatabaseContext<S>
): ctx is { type: 'postgres'; db: DrizzlePgClient<S> } {
  return ctx.type === 'postgres';
}

export function getDb<S extends DrizzleSchema>(
  env: AppEnvBindings,
  schema: S,
  optionsOrCfInfo?: CfInfo | DbContextOptions
): DrizzleD1Client<S> | DrizzlePgClient<S> {
  const options = getNormalizedDbContextOptions(optionsOrCfInfo);
  const cfInfo = options.cfInfo;
  const pgEdgeRouter = options.pgEdgeRouter || defaultPgEdgeRouter;
  const postgresBindingRole = options.postgresBindingRole;
  const normalizedPostgresBindingRole = normalizePostgresBindingRole(postgresBindingRole);
  const dbEngine = env.DB_ENGINE || 'auto-detect';
  const logger = getLogger();
  const continent = cfInfo?.continent ?? env.__cfContinent ?? undefined;

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
    const { candidates, orderedLocations } = buildOrderedPostgresCandidates(
      env,
      postgresBindingRole,
      locations,
      pgEdgeRouter,
      continent,
      cfInfo
    );

    if (env.PGEDGE_DEBUG_LOGGING) {
      logger.debug('[getDb] Resolved postgres binding candidates', {
        postgresBindingRole: normalizedPostgresBindingRole || 'DEFAULT',
        orderedLocations,
        candidates: candidates.map(formatCandidateLabel),
      });
    }

    if (candidates.length === 0) {
      const allAvailableBindings: Record<string, string[]> = {};
      orderedLocations.forEach((location) => {
        const available = getAvailablePostgresBindingsForLocation(env, location);
        if (available.length > 0) {
          allAvailableBindings[location] = available;
        }
      });

      logger.error('[getDb] No POSTGRES binding found', undefined, {
        locationsCount: locations.length,
        orderedLocations,
        postgresBindingRole: normalizedPostgresBindingRole || 'DEFAULT',
        allAvailableBindings,
        allAvailablePostgresBindings: Object.keys(env).filter(
          (key) => key.startsWith('POSTGRES') && typeof env[key] === 'object' && env[key] !== null
        ),
        envKeys: Object.keys(env).filter(
          (key) => key.startsWith('POSTGRES') || key.startsWith('PGEDGE') || key === 'DB_ENGINE'
        ),
      });
      throw new Error("POSTGRES binding with connectionString is required when DB_ENGINE is set to 'postgres'. If using roles, ensure role-specific bindings exist or fallback POSTGRES bindings are configured.");
    }

    const failoverOptions = resolvePgFailoverOptions(env, candidates.length);

    if (env.PGEDGE_DEBUG_LOGGING) {
      logger.debug('[getDb] PostgreSQL failover config', {
        candidates: candidates.map(formatCandidateLabel),
        failoverEnabled: failoverOptions.enabled,
        failoverConnectionTimeoutMs: failoverOptions.connectionTimeoutMs,
        failoverWarnLogging: failoverOptions.warnLogging,
      });
    }

    if (failoverOptions.enabled && candidates.length > 1) {
      return createFailoverPgDrizzleClient(candidates, schema, failoverOptions);
    }

    return createPrimaryPgDrizzleClient(candidates[0]!, schema);
  }

  if (dbEngine === 'd1-sqlite' || (dbEngine === 'auto-detect' && env.D1)) {
    if (!env.D1) {
      throw new Error("D1 binding is required when DB_ENGINE is set to 'd1-sqlite'");
    }
    return createD1DrizzleClient(env.D1, schema);
  }

  throw new Error('No database binding found: bind either POSTGRES or D1 in your worker');
}
