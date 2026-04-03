import { eq } from 'drizzle-orm';
import { isSQLite, type DatabaseContext } from '../../db/client';
// Schema placeholder - the framework does NOT define any tables
// Instead, define them in your application
type AppSchema = Record<string, unknown>;


// Database client interface for token metadata update
export interface TokenMetadataUpdateClient {
  ctx: DatabaseContext<AppSchema>;
  schema: AppSchema;
}

// Update the lastUsedAt timestamp for a token
export async function updateTokenLastUsed(
  client: TokenMetadataUpdateClient,
  tokenUid: string
): Promise<void> {
  const useSqlite = isSQLite(client.ctx);
  const table = useSqlite ? client.schema.tokensSqlite : client.schema.tokens;
  await (client.ctx.db as { update: (table: unknown) => { set: (data: unknown) => { where: (condition: unknown) => Promise<void> } } }).update(table)
    .set({ lastUsedAt: useSqlite ? new Date().toISOString() : new Date() })
    .where(eq((table as any).uid, tokenUid));
}
