import { isSQLite, type DatabaseContext } from './index';

/**
 * Convert boolean to SQLite 0/1 or keep as boolean for PostgreSQL using database context
 */
export function convertBooleanForDb(value: boolean, ctx: DatabaseContext): boolean | number {
  return isSQLite(ctx) ? (value ? 1 : 0) : value;
}
