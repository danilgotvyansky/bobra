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
 * Creates a SQLite FTS5 query condition for full-text search.
 * 
 * FTS5 virtual tables provide efficient full-text search with:
 * - Tokenization: automatically splits text into tokens
 * - Inverted index: maps words to documents containing them
 * - Prefix matching: "word*" finds "word", "words", "wording", etc.
 * - Boolean operators: AND, OR, NOT
 * - Phrase search: quoted strings for exact phrases
 * - Ranking: relevance scoring for results
 * 
 * FTS5 tables must be created with:
 * CREATE VIRTUAL TABLE user_search_fts USING fts5(
 *   auth_id UNINDEXED,
 *   searchable_text,
 *   content='users',
 *   content_rowid='uid'
 * );
 * 
 * And kept in sync via triggers on INSERT/UPDATE/DELETE.
 * 
 * @param tableName - The FTS5 virtual table name (e.g., 'user_search_fts', 'token_search_fts')
 * @param query - The search query string (will be split into terms and escaped)
 * @returns A SQL chunk representing the FTS5 MATCH condition
 * 
 * @example
 * // Simple term search on user_search_fts
 * sql`${createFts5SearchQuery('user_search_fts', 'John')}`
 * // Result: user_search_fts MATCH '"John"*'
 * 
 * // Multi-term search (implicit AND)
 * sql`${createFts5SearchQuery('user_search_fts', 'John Doe')}`
 * // Result: user_search_fts MATCH '"John"* AND "Doe"*'
 * 
 * // Special characters are escaped
 * sql`${createFts5SearchQuery('user_search_fts', 'test@example.com')}`
 * // Result: user_search_fts MATCH '"test@example.com"*'
 */
export function createFts5SearchQuery(tableName: string, query: string): SQL {
  const sanitizedQuery = query.trim();

  if (!sanitizedQuery) {
    return sql`1=0`;
  }

  // FTS5 MATCH syntax:
  // - "term" or term - matches the term
  // - term* - prefix match (matches term, terms, terminate, etc.)
  // - "phrase match" - exact phrase
  // - term1 AND term2 - both must match
  // - term1 OR term2 - at least one must match
  // - NOT term - must not match
  // - term1 AND (term2 OR term3) - complex boolean

  // Split query into terms and escape each one as a phrase/string literal
  // This prevents special characters like -, @, etc. from being interpreted as operators
  // and causing syntax errors (e.g. "self-hosted-test@example.com" containing - and @)
  const terms = sanitizedQuery.split(/\s+/).map(term => {
    const escaped = term.replace(/"/g, '""');
    return `"${escaped}"*`;
  });

  const finalQuery = terms.join(' AND ');

  // IMPORTANT: We must escape single quotes in the final query string because it's being
  // interpolated into a SQL string literal wrapped in single quotes.
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
