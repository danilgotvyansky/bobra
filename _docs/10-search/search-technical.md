Bobra provides a search implementation leveraging SQLite's **FTS5** extension for Edge deployments (D1/SQLite) and native **PostgreSQL Full-Text Search (TSVector)** for centralized deployments.

## SQLite FTS5 (Edge)

Leverages a "Content-Linked Virtual Table" pattern for blazingly fast searches on SQLite.

### Architecture
1.  **Source Table**: The primary source of truth (e.g., `users`).
2.  **Virtual Table**: An FTS5 virtual table (e.g., `users_fts`) that stores indexed text.
3.  **Triggers**: SQL triggers that propagate changes from the source table to the virtual table.

### Manual SQL Migrations
As noted in the [Database Guide](../05-database/database.md), FTS5 tables are NOT fully managed by Drizzle. You must manually modify your SQLite migrations.

#### 1. Table Creation
Change the generated `CREATE TABLE` to a virtual table definition:

```sql
-- Manually modified migration
CREATE VIRTUAL TABLE users_fts USING fts5(
  auth_id UNINDEXED, -- Store ID without indexing it
  searchable_text,    -- The text to be indexed
  content='users',
  content_rowid='uid'
);
```

#### 2. Synchronization Triggers
Add triggers to your migration to handle `INSERT`, `UPDATE`, and `DELETE` operations.

```sql
-- Sync on Insert
CREATE TRIGGER user_ai_fts AFTER INSERT ON users BEGIN
  INSERT INTO user_search_fts(user_id, searchable_text)
  VALUES (new.uid, new.email || ' ' || new.first_name || ' ' || new.last_name);
END;
```

## PostgreSQL Search (Native TSVector)

For PostgreSQL, Bobra uses native **TSVector** and **TSQuery** capabilities, providing a powerful and scalable search solution without needing separate virtual tables.

### `websearch_to_tsquery`
Bobra utilizes `websearch_to_tsquery`, which provides a safe, Google-like search syntax:
- `"quoted phrase"` for exact matches.
- `-minus` to exclude terms.
- `OR` for alternatives.
- Implicit `AND` between terms.

### Implementation

Use the `createPostgresSearchQuery` utility from the search battery:

```typescript
import { createPostgresSearchQuery } from '@danylohotvianskyi/bobra-framework/batteries/search';

const results = await db
  .select()
  .from(users)
  .where(
    createPostgresSearchQuery(
      [users.email, users.first_name, users.last_name],
      'john -doe'
    )
  );
```

### Performance (GIN Indexes)
To ensure high performance on large datasets, you should define a **GIN index** on the searchable expressions in your PostgreSQL schema:

```typescript
export const users = pgTable("users", {
  // ... columns
}, (table) => ({
  idx_users_search: pgIndex("idx_users_search").using(
    'gin', 
    sql`to_tsvector('english', coalesce(${table.email}, '') || ' ' || coalesce(${table.first_name}, '') || ' ' || coalesce(${table.last_name}, ''))`
  ),
}));
```

## Comparisons

| Feature | SQLite FTS5 | PostgreSQL TSVector |
| :--- | :--- | :--- |
| **Indexing** | Virtual table + Triggers | Expression Index (GIN) |
| **Search Syntax** | Standard FTS5 MATCH | `websearch_to_tsquery` (Safe) |
| **Ranking** | `rank`, `bm25` | `ts_rank`, `ts_rank_cd` |
| **Flexibility** | Higher (custom triggers) | Lower (easier to manage) |
| **Performance** | Excellent for Edge | High Scalability |
