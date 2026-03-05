import type { Config } from 'drizzle-kit';
import 'dotenv/config';

// Type guard to make TypeScript happy without @types/node
declare const process: { 
  env?: { 
    POSTGRES_CONNECTION_STRING?: string, 
    MIGRATION_POSTGRES_CONNECTION_STRING?: string,
    DB_ENGINE?: string 
  } 
};

// Get DB_ENGINE from environment, defaulting to 'd1-sqlite' if not set
const dbEngine = typeof process !== 'undefined' && process.env?.DB_ENGINE
  ? process.env.DB_ENGINE
  : 'd1-sqlite';

// Set dialect based on DB_ENGINE
const dialect = dbEngine === 'postgres' ? 'postgresql' : 'sqlite';

console.log(`Using dialect: ${dialect} (DB_ENGINE=${dbEngine})`);

// Get the PostgreSQL connection string
// For migrations, prefer MIGRATION_POSTGRES_CONNECTION_STRING (with migration_user)
// Fallback to POSTGRES_CONNECTION_STRING for backwards compatibility
const postgresConnectionString = 
  process.env?.MIGRATION_POSTGRES_CONNECTION_STRING ||
  process.env?.POSTGRES_CONNECTION_STRING || 
  '';

// Create separate migration folders for each dialect to avoid conflicts
const migrationFolder = dialect === 'postgresql' 
  ? './src/db/migrations-pg' 
  : './src/db/migrations-sqlite';

export default {
  schema: './src/db/schema.ts',
  out: migrationFolder,
  dialect,
  // For SQLite (D1)
  ...(dialect === 'sqlite' && {
    dbCredentials: {
      url: './local.db',
    }
  }),
  // For PostgreSQL
  ...(dialect === 'postgresql' && {
    dbCredentials: {
      url: postgresConnectionString,
    }
  }),
  verbose: true,
} satisfies Config;
