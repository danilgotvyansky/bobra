/**
 * Unified Migration System
 * 
 * This script automatically detects the database engine and runs migrations.
 * - If DB_ENGINE is set to 'postgres', it uses PostgreSQL with POSTGRES.connectionString
 * - If DB_ENGINE is set to 'd1-sqlite' or not set, it uses Cloudflare D1
 * 
 * ⚠️  IMPORTANT: Full-Text Search (FTS5) Tables
 * FTS5 and other virtual/computed tables are NOT defined in the Drizzle schema.
 * Instead, they are:
 * 1. Defined as regular tables in schema.ts (for TypeScript types)
 * 2. Created manually in SQL migrations (migrations-sqlite/ and migrations-pg/)
 * 3. Kept in sync via database triggers
 * 
 * This separation is necessary because:
 * - SQLite FTS5 virtual tables cannot be expressed in Drizzle's type system
 * - PostgreSQL's GENERATED ALWAYS AS STORED columns need manual SQL setup
 * - Both require custom triggers to maintain synchronization
 * 
 * When adding new FTS5 searches:
 * 1. Add type definitions to schema.ts (for IDE autocompletion)
 * 2. Create migration SQL files manually
 * 3. Implement corresponding query functions in search/ directory
 * 
 * Usage:
 * pnpm run migrate -- --local --persist-to=path/to/persist
 * 
 * With explicit DB_ENGINE:
 * DB_ENGINE=postgres pnpm run migrate
 */

import 'dotenv/config';
import * as path from 'path';
import { loadEnvFiles } from '../node';

// Load .dev.vars and .env files (Node.js only)
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  const envVars = loadEnvFiles();
  // Merge into process.env (process.env takes precedence)
  envVars.forEach((value, key) => {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

// Only import Node.js specific modules conditionally
let execSync: Function | null = null;
let fs: any = null;

// Check if we're in Node.js environment
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

if (isNode) {
  // We're in Node.js - import Node-specific modules
  const childProcess = require('child_process');
  execSync = childProcess.execSync;
  fs = require('fs');
}

// Import DB modules that work in both environments
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as pgMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createPublicApiToken } from '../batteries/auth/token';

// Configuration based on database engine
const getConfig = () => {
  const dbEngine = process.env.DB_ENGINE || 'd1-sqlite';
  const isPostgres = dbEngine === 'postgres';

  // Use different migration folders for different dialects
  const migrationsDir = 'src/db/migrations-pg';

  return {
    migrationsDir,
    isPostgres
  };
};

// Parse command line arguments
function parseArgs() {
  if (!isNode) return { persistTo: '', local: false, remote: false, wranglerConfig: '', skipGenerate: false };

  const args = process.argv.slice(2);
  const options = {
    persistTo: '',
    local: false,
    remote: false,
    wranglerConfig: '',
    skipGenerate: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--persist-to=')) {
      options.persistTo = args[i].split('=')[1];
    } else if (args[i].startsWith('--wrangler-config=')) {
      options.wranglerConfig = args[i].split('=')[1];
    } else if (args[i] === '--local') {
      options.local = true;
    } else if (args[i] === '--remote') {
      options.remote = true;
    } else if (args[i] === '--skip-generate') {
      options.skipGenerate = true;
    }
  }

  return options;
}

const options = parseArgs();
// Default persist directory if not provided via command line
const PERSIST_DIR = isNode && options.persistTo
  ? path.resolve(process.cwd(), options.persistTo)
  : isNode
    ? path.resolve(process.cwd(), '../.wrangler/shared-state')
    : './.wrangler/state/v3/d1';

/**
 * Main migration function
 */
export async function runMigrations(): Promise<void> {
  // Only run migrations in Node.js environment
  if (!isNode) {
    console.log('Skipping migrations in Workers environment');
    return;
  }

  try {
    console.log('🔍 Detecting database environment...');

    // Get DB_ENGINE from environment, defaulting to 'd1-sqlite' if not set
    const dbEngine = process.env.DB_ENGINE || 'd1-sqlite';
    console.log(`DB_ENGINE: ${dbEngine}`);

    // Get configuration
    const config = getConfig();

    // Use the appropriate database based on DB_ENGINE
    if (dbEngine === 'postgres') {
      // PostgreSQL mode
      console.log('🐘 PostgreSQL mode selected');

      const connectionString = process.env.MIGRATION_POSTGRES_CONNECTION_STRING ||
        process.env.POSTGRES_CONNECTION_STRING ||
        'postgresql://bobra_user:bobra_password@localhost:5432/bobra-db';

      if (!connectionString) {
        console.error('❌ MIGRATION_POSTGRES_CONNECTION_STRING or POSTGRES_CONNECTION_STRING is required when using DB_ENGINE=postgres');
        process.exit(1);
      }

      console.log(`Using PostgreSQL connection string`);
      await runPostgresMigrations(config.migrationsDir, connectionString, options.skipGenerate);
    } else {
      // Cloudflare D1 mode  
      console.log('☁️ Cloudflare D1 mode selected');
      await runD1Migrations(options);
    }

    console.log('✅ Migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

/**
 * Run PostgreSQL migrations
 */
async function runPostgresMigrations(migrationsDir: string, connectionString: string, skipGenerate: boolean): Promise<void> {
  if (!isNode || !execSync) {
    console.error('PostgreSQL migrations are only supported in Node.js environment');
    return;
  }

  try {
    if (!skipGenerate) {
      console.log('📝 Generating migrations for PostgreSQL...');
      execSync('pnpm exec drizzle-kit generate', {
        stdio: 'inherit',
        env: {
          ...process.env,
          DB_ENGINE: 'postgres',
          MIGRATION_POSTGRES_CONNECTION_STRING: connectionString
        }
      });
    } else {
      console.log('⏭️  Skipping migration generation (--skip-generate)');
    }

    console.log('🚀 Applying migrations to PostgreSQL...');

    if (!connectionString) {
      throw new Error('PostgreSQL connection string is required for migrations');
    }

    // 1. Wait for PostgreSQL to be fully ready (not just port open)
    const waitForReady = async () => {
      const maxAttempts = 30;
      const delayMs = 1000;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const sql = postgres(connectionString, { max: 1 });
          // Run a simple query to check readiness
          await sql`SELECT 1`;
          await sql.end();
          return;
        } catch (err) {
          console.log(`Waiting for PostgreSQL to be ready... (${i + 1}/${maxAttempts})`);
          await new Promise(res => setTimeout(res, delayMs));
        }
      }
      throw new Error('PostgreSQL did not become ready in time');
    };

    await waitForReady();

    // 2. Run Migrations
    const sql = postgres(connectionString);
    const db = drizzle(sql);

    await pgMigrate(db, { migrationsFolder: migrationsDir });
    await sql.end();

    console.log('✅ PostgreSQL migrations applied');
    console.log('\n📌 Full-Text Search Setup Notes:');
    console.log('  - PostgreSQL searchable_text column created for alert_instances');
    console.log('  - GIN index on searchable_text enables fast FTS queries');
    console.log('  - Column automatically updated via GENERATED ALWAYS AS STORED');
    console.log('  - Use native to_tsvector/to_tsquery for PostgreSQL FTS');

    await createInitialTokenPostgres(connectionString);
  } catch (error) {
    console.error('❌ PostgreSQL migration error:', error);
    throw error;
  }
}

/**
 * Run Cloudflare D1 migrations
 */
async function runD1Migrations(
  options: { persistTo: string, local: boolean, remote: boolean, wranglerConfig: string, skipGenerate: boolean },
): Promise<void> {
  if (!isNode || !execSync || !fs) {
    console.log('D1 migrations are only supported in Node.js environment');
    return;
  }

  try {
    if (!options.skipGenerate) {
      console.log('📝 Generating migrations for D1...');
      execSync('pnpm exec drizzle-kit generate', {
        stdio: 'inherit',
        env: {
          ...process.env,
          DB_ENGINE: 'd1-sqlite'
        }
      });
    } else {
      console.log('⏭️  Skipping migration generation (--skip-generate)');
    }

    console.log('🚀 Applying migrations to D1...');

    if (!options.wranglerConfig) {
      throw new Error('--wrangler-config argument is required for D1 migrations. Please specify the path to wrangler.jsonc file.');
    }

    const wranglerPath = path.resolve(process.cwd(), options.wranglerConfig);

    let command = `pnpm exec wrangler d1 migrations apply D1 -c ${wranglerPath}`;

    if (options.remote) {
      command += ' --remote';
      console.log('🌐 Using remote database');
    } else {
      // Default to local database
      const useLocal = options.local || options.persistTo;
      if (useLocal) {
        command += ' --local';
        console.log('💻 Using local database');
      }

      if (options.persistTo) {
        console.log(`💾 Using persist directory: ${PERSIST_DIR}`);

        if (!fs.existsSync(PERSIST_DIR)) {
          fs.mkdirSync(PERSIST_DIR, { recursive: true });
        }

        command += ` --persist-to=${PERSIST_DIR}`;
      }
    }

    console.log(`Executing: ${command}`);
    execSync(command, { stdio: 'inherit' });

    console.log('✅ D1 migrations applied');
    console.log('\n📌 FTS5 Setup Notes:');
    console.log('  - SQLite FTS5 virtual table "alert_search_fts" created');
    console.log('  - INSERT/UPDATE/DELETE triggers automatically sync with alert_instances table');
    console.log('  - Use createAlertFts5SearchQuery() for efficient full-text search');
    console.log('  - LIKE queries are still available as fallback via createSQLiteLikeSearchQuery()');

    await createInitialTokenD1(options);
  } catch (error) {
    console.error('❌ D1 migration error:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function createInitialTokenPostgres(connectionString: string) {
  const sqlClient = postgres(connectionString);
  try {
    const [{ exists }] = await sqlClient`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'init_token_created') as exists`;
    if (!exists) {
      console.log('ℹ️ init_token_created table not found, skipping initial token creation');
      await sqlClient.end();
      return;
    }
    const already = await sqlClient`SELECT created FROM init_token_created WHERE id = 'singleton' LIMIT 1`;
    if (already.length > 0 && already[0].created) {
      console.log('✅ Initial token already created, skipping');
      await sqlClient.end();
      return;
    }
    const { token, record } = await createPublicApiToken({ initToken: true, name: 'Initial Instance Token' });
    await sqlClient`
      INSERT INTO tokens (uid, name, token_hash, token_salt, ip_addresses, expires_at, created_at, last_used_at, init_token)
      VALUES (${record.uid}, ${record.name || null}, ${record.tokenHash}, ${record.tokenSalt}, ${JSON.stringify(record.ipAddresses || [])}::jsonb, ${new Date(record.expiresAt)}, ${new Date(record.createdAt)}, ${null}, ${true})
    `;

    // Run any app-specific SQL after core token insert (e.g. linking token to organizations)
    if (process.env.INIT_TOKEN_EXTRA_SQL) {
      try {
        await sqlClient.unsafe(process.env.INIT_TOKEN_EXTRA_SQL.replace(/\$TOKEN_UID/g, record.uid));
      } catch {
        // Extra SQL is best-effort (table might not exist in all apps)
      }
    }

    await sqlClient`INSERT INTO init_token_created (id, created, created_at) VALUES ('singleton', ${true}, ${new Date().toISOString()}) ON CONFLICT (id) DO UPDATE SET created = ${true}`;
    console.log('🔑 Initial token generated (store it securely):', token);
  } finally {
    await sqlClient.end();
  }
}

async function createInitialTokenD1(options: { wranglerConfig: string, local?: boolean, remote?: boolean, persistTo?: string }) {
  if (!execSync) return;
  const { token, record } = await createPublicApiToken({ initToken: true, name: 'Initial Instance Token' });
  const wranglerPath = path.resolve(process.cwd(), options.wranglerConfig);

  const buildBase = () => {
    let base = `pnpm exec wrangler d1 execute D1 -c ${wranglerPath}`;
    if (options.remote) {
      base += ' --remote';
    } else if (options.local || options.persistTo) {
      base += ' --local';
      if (options.persistTo) {
        base += ` --persist-to=${PERSIST_DIR}`;
      }
    }
    return base;
  };

  const insertSql = [
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE IF NOT EXISTS init_token_created (id TEXT PRIMARY KEY, created INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);',
    "INSERT OR IGNORE INTO init_token_created (id, created, created_at) VALUES ('singleton', 0, datetime('now'));"
  ].join(' ');

  try {
    const prepCmd = `${buildBase()} --command "${insertSql}"`;
    execSync(prepCmd, { stdio: 'pipe' });
  } catch { }

  const needSql = "SELECT CASE WHEN (SELECT created FROM init_token_created WHERE id='singleton')=0 THEN 'NEED' ELSE 'SKIP' END AS state;";
  let needOut = '';
  try {
    needOut = execSync(`${buildBase()} --command "${needSql}"`, { stdio: 'pipe' }).toString();
  } catch {
    // Table might not exist yet
  }
  const need = /NEED/.test(needOut);

  if (need) {
    // Core token insert — runs for all Bobra apps
    const coreSql = [
      `INSERT INTO tokens (uid, name, token_hash, token_salt, ip_addresses, expires_at, created_at, last_used_at, init_token)`,
      `SELECT '${record.uid}', ${record.name ? `'${record.name.replace(/'/g, "''")}'` : 'NULL'}, '${record.tokenHash}', '${record.tokenSalt}', '[]', '${new Date(record.expiresAt).toISOString()}', '${new Date(record.createdAt).toISOString()}', NULL, 1`,
      `WHERE (SELECT created FROM init_token_created WHERE id = 'singleton') = 0;`,
      "UPDATE init_token_created SET created = 1, created_at = datetime('now') WHERE id = 'singleton' AND created = 0;"
    ].join(' ').replace(/\\n/g, ' ');

    try {
      execSync(`${buildBase()} --command "${coreSql}"`, { stdio: 'inherit' });
      console.log('🔑 Initial token generated (store it securely):', token);
    } catch {
      console.warn('⚠️ Failed to insert initial token.');
      return;
    }

    // App-specific extra SQL (e.g. linking token to organizations via INIT_TOKEN_EXTRA_SQL env var)
    if (process.env.INIT_TOKEN_EXTRA_SQL) {
      const extraSql = process.env.INIT_TOKEN_EXTRA_SQL.replace(/\$TOKEN_UID/g, record.uid);
      try {
        execSync(`${buildBase()} --command "${extraSql}"`, { stdio: 'inherit' });
      } catch {
        // Extra SQL is best-effort (referenced tables might not exist in all apps)
        console.warn('⚠️ Extra init token SQL failed (table might not exist in this app).');
      }
    }
  }
}

// For command-line usage
if (isNode && require.main === module) {
  runMigrations();
}
