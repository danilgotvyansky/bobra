import {
  getDb as _getDb,
  getDatabaseContext as _getDatabaseContext,
  isSQLite,
  type AppEnvBindings,
  type DatabaseContext,
  type DrizzleD1Client,
  type DrizzlePgClient,
  hasPostgresBindings,
  type PgEdgeRouter
} from '@danylohotvianskyi/bobra-framework/db';
import * as schema from './schema';

export { isSQLite, type DatabaseContext, type DrizzleD1Client, type DrizzlePgClient, hasPostgresBindings };

// Example of a custom pgEdge router that overrides the default routing logic
const customPgEdgeRouter: PgEdgeRouter = (locations: string[], cfContinentStr?: string, cfInfo?: any) => {
  // You can implement any custom routing logic here based on locations and Cloudflare context
  // For example, routing all requests to a specific region for debugging
  if (cfContinentStr === 'EU' && locations.includes('eu')) {
    return 'eu';
  } else if (cfContinentStr === 'NA' && locations.includes('us')) {
    return 'us';
  } else if (cfContinentStr === 'AS' && locations.includes('ap')) {
    return 'ap';
  } else if (locations.includes('eu')) {
    return 'eu'; // Fallback to EU
  }

  // Always return the first location as absolute fallback
  return locations[0]!;
};

// Pre-bind token schema so existing getDb(env) calls don't need changes
export function getDb(env: AppEnvBindings) {
  // Pass the custom router via options
  return _getDb(env, schema, { pgEdgeRouter: customPgEdgeRouter });
}

export function getDatabaseContext(env: AppEnvBindings) {
  // Pass the custom router via options
  return _getDatabaseContext(env, schema, { pgEdgeRouter: customPgEdgeRouter });
}
