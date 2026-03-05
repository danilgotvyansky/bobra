import { sql, SQL } from 'drizzle-orm';

/**
 * Creates a Postgres Full Text Search query using to_tsvector and websearch_to_tsquery.
 *
 * websearch_to_tsquery provides safe, web-style search syntax:
 * - "quoted phrase" for exact match
 * - -word to exclude
 * - OR for alternatives
 * - Implicit AND between terms
 *
 * The query parameter is fully parameterized — no raw SQL injection risk.
 */
export function createPostgresSearchQuery(
  columns: (SQL | any)[],
  query: string,
  language: string = 'english'
): SQL {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return sql`1=0`;
  }

  const coalescedColumns = columns.map(col => sql`coalesce(${col}, '')`);
  const vector = sql.join(coalescedColumns, sql` || ' ' || `);

  return sql`to_tsvector(${language}, ${vector}) @@ websearch_to_tsquery(${language}, ${trimmedQuery})`;
}

/**
 * Creates a SQLite FTS5 query condition.
 *
 * FTS5 virtual tables provide efficient full-text search with tokenization,
 * prefix matching, boolean operators, and relevance ranking.
 */
export function createFts5SearchQuery(tableName: string, query: string): SQL {
  const sanitizedQuery = query.trim();

  if (!sanitizedQuery) {
    return sql`1=0`;
  }

  // Escape each term as a phrase literal and add prefix matching
  const terms = sanitizedQuery.split(/\s+/).map(term => {
    const escaped = term.replace(/"/g, '""');
    return `"${escaped}"*`;
  });

  const finalQuery = terms.join(' AND ');

  // SQL string literal — escape single quotes
  return sql.raw(`${tableName} MATCH '${finalQuery.replace(/'/g, "''")}'`);
}

/**
 * Creates a SQLite LIKE query for fallback search (when FTS5 tables don't exist).
 */
export function createSQLiteLikeSearchQuery(
  columns: (SQL | any)[],
  query: string
): SQL {
  const searchTerm = query.trim();

  if (!searchTerm) {
    return sql`1=0`;
  }

  const coalescedColumns = columns.map(col => sql`coalesce(${col}, '')`);
  const vector = sql.join(coalescedColumns, sql` || ' ' || `);

  return sql`${vector} LIKE ${'%' + searchTerm + '%'} COLLATE NOCASE`;
}
