import { getLogger } from '../logging/logger';
import type {
  AppEnvBindings,
  CfInfo,
  PgEdgeRouter,
  PgFailoverOptions,
  PostgresBinding,
  PostgresBindingRole,
  PostgresCandidate,
  ResolvedPostgresBinding,
} from './types';

const DEFAULT_FAILOVER_CONNECTION_TIMEOUT_MS = 2000;

function isPostgresBinding(value: unknown): value is PostgresBinding {
  return typeof value === 'object' && value !== null;
}

export function normalizePostgresBindingRole(role?: PostgresBindingRole): string | undefined {
  const trimmedRole = role?.trim();
  if (!trimmedRole) return undefined;

  const normalizedRole = trimmedRole.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!normalizedRole || normalizedRole === 'DEFAULT') return undefined;
  return normalizedRole;
}

export function getPostgresLocationBindingCandidates(location: string, role?: PostgresBindingRole): string[] {
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

export function getAvailablePostgresBindingsForLocation(env: AppEnvBindings, location: string): string[] {
  const normalizedLocation = location.toUpperCase();
  const availableBindings: string[] = [];

  Object.keys(env).forEach((key) => {
    if (key.startsWith(`POSTGRES_${normalizedLocation}_`) || key === `POSTGRES_${normalizedLocation}`) {
      if (isPostgresBinding(env[key])) {
        availableBindings.push(key);
      }
    }
  });

  return availableBindings;
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
    if (isPostgresBinding(binding)) {
      return {
        bindingName,
        binding,
      };
    }
  }

  return undefined;
}

function parseBooleanEnv(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === 'true') return true;
    if (normalizedValue === 'false') return false;
  }
  return defaultValue;
}

function parsePositiveIntegerEnv(value: unknown, defaultValue: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return defaultValue;
}

function resolveFallbackBindingCandidates(
  availableBindings: string[],
  normalizedPostgresBindingRole?: string
): string[] {
  if (!normalizedPostgresBindingRole) {
    const liveBindings = availableBindings.filter((binding) => binding.endsWith('_LIVE'));
    return liveBindings.length > 0 ? liveBindings : availableBindings;
  }

  const fallbackCandidates = availableBindings.filter(
    (binding) => !binding.includes(`_${normalizedPostgresBindingRole}`)
  );
  return fallbackCandidates.length > 0 ? fallbackCandidates : availableBindings;
}

function resolvePostgresLocationCandidate(
  env: AppEnvBindings,
  location: string,
  postgresBindingRole?: PostgresBindingRole
): PostgresCandidate | undefined {
  const normalizedPostgresBindingRole = normalizePostgresBindingRole(postgresBindingRole);
  const directResolved = resolvePostgresBindingByCandidates(
    env,
    getPostgresLocationBindingCandidates(location, postgresBindingRole)
  );

  if (directResolved) {
    return {
      ...directResolved,
      location,
    };
  }

  const availableBindings = getAvailablePostgresBindingsForLocation(env, location);
  if (availableBindings.length === 0) return undefined;

  const preferredBindings = resolveFallbackBindingCandidates(
    availableBindings,
    normalizedPostgresBindingRole
  );
  const fallbackBinding = resolvePostgresBindingByCandidates(env, preferredBindings);

  if (!fallbackBinding) return undefined;
  return {
    ...fallbackBinding,
    location,
  };
}

function resolveSinglePostgresCandidate(
  env: AppEnvBindings,
  postgresBindingRole?: PostgresBindingRole
): PostgresCandidate | undefined {
  const directResolved = resolvePostgresBindingByCandidates(
    env,
    getSinglePostgresBindingCandidates(postgresBindingRole)
  );

  if (directResolved) {
    return directResolved;
  }

  const normalizedPostgresBindingRole = normalizePostgresBindingRole(postgresBindingRole);
  const allPostgresBindings = Object.keys(env).filter(
    (key) => key.startsWith('POSTGRES') && isPostgresBinding(env[key])
  );

  if (allPostgresBindings.length === 0) return undefined;

  const preferredBindings = resolveFallbackBindingCandidates(
    allPostgresBindings,
    normalizedPostgresBindingRole
  );
  return resolvePostgresBindingByCandidates(env, preferredBindings);
}

function dedupePostgresCandidates(candidates: PostgresCandidate[]): PostgresCandidate[] {
  const seenBindingNames = new Set<string>();
  const dedupedCandidates: PostgresCandidate[] = [];

  for (const candidate of candidates) {
    if (seenBindingNames.has(candidate.bindingName)) continue;
    seenBindingNames.add(candidate.bindingName);
    dedupedCandidates.push(candidate);
  }

  return dedupedCandidates;
}

export function buildOrderedPostgresCandidates(
  env: AppEnvBindings,
  postgresBindingRole: PostgresBindingRole | undefined,
  locations: string[],
  pgEdgeRouter: PgEdgeRouter,
  continent: string | undefined,
  cfInfo: CfInfo | undefined
): { candidates: PostgresCandidate[]; orderedLocations: string[] } {
  if (locations.length === 0) {
    const singleCandidate = resolveSinglePostgresCandidate(env, postgresBindingRole);
    return {
      candidates: singleCandidate ? [singleCandidate] : [],
      orderedLocations: [],
    };
  }

  let orderedLocations = [...locations];
  if (locations.length > 1) {
    const targetLocation = pgEdgeRouter(locations, (continent || '').toUpperCase(), cfInfo);
    orderedLocations = [targetLocation, ...locations.filter((location) => location !== targetLocation)];
  }

  const pgEdgeCandidates = orderedLocations
    .map((location) => resolvePostgresLocationCandidate(env, location, postgresBindingRole))
    .filter((candidate): candidate is PostgresCandidate => !!candidate);
  const singleCandidate = resolveSinglePostgresCandidate(env, postgresBindingRole);

  return {
    candidates: dedupePostgresCandidates(singleCandidate ? [...pgEdgeCandidates, singleCandidate] : pgEdgeCandidates),
    orderedLocations,
  };
}

export function resolvePgFailoverOptions(env: AppEnvBindings, candidateCount: number): PgFailoverOptions {
  const defaultFailoverEnabled = candidateCount > 1;
  return {
    enabled: parseBooleanEnv(env.PGEDGE_FAILOVER_ENABLED, defaultFailoverEnabled),
    connectionTimeoutMs: parsePositiveIntegerEnv(
      env.PGEDGE_FAILOVER_CONNECTION_TIMEOUT_MS,
      DEFAULT_FAILOVER_CONNECTION_TIMEOUT_MS
    ),
    warnLogging: parseBooleanEnv(env.PGEDGE_FAILOVER_WARN_LOGGING, true),
  };
}

export function formatCandidateLabel(candidate: PostgresCandidate): string {
  return candidate.location ? `${candidate.bindingName}(${candidate.location})` : candidate.bindingName;
}

export function readCandidateConnectionString(candidate: PostgresCandidate): string {
  return candidate.binding.connectionString;
}

export const defaultPgEdgeRouter: PgEdgeRouter = (locations: string[], cfContinentStr?: string) => {
  let targetLocation = locations[0]!;

  if (cfContinentStr === 'EU' && locations.includes('eu')) {
    targetLocation = 'eu';
  } else if (cfContinentStr === 'NA' && locations.includes('us')) {
    targetLocation = 'us';
  } else if (locations.includes('eu')) {
    targetLocation = 'eu';
  }

  return targetLocation;
};

export function getPgEdgeLocations(env: AppEnvBindings): string[] {
  const isPgEdgeEnabled = env.PGEDGE_ENABLED === true || env.PGEDGE_ENABLED === 'true';
  if (!isPgEdgeEnabled) return [];

  let pgedgeLocations: string[] = [];
  if (env.PGEDGE_LOCATIONS) {
    try {
      const parsed = typeof env.PGEDGE_LOCATIONS === 'string'
        ? JSON.parse(env.PGEDGE_LOCATIONS)
        : env.PGEDGE_LOCATIONS;

      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        pgedgeLocations = parsed.map((item) => item.toLowerCase());
      } else {
        getLogger().warn('PGEDGE_LOCATIONS must be an array of strings');
      }
    } catch (e) {
      const parseError = e instanceof Error ? e : new Error(String(e));
      getLogger().warn('Failed to parse PGEDGE_LOCATIONS', {
        name: parseError.name,
        message: parseError.message,
      });
    }
  }
  return pgedgeLocations;
}

export function hasPostgresBindings(env: AppEnvBindings, role?: PostgresBindingRole): boolean {
  const locations = getPgEdgeLocations(env);
  const { candidates } = buildOrderedPostgresCandidates(
    env,
    role,
    locations,
    defaultPgEdgeRouter,
    undefined,
    undefined
  );
  return candidates.length > 0;
}
