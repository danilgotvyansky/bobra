import { eq } from 'drizzle-orm';
import { isSQLite, type DatabaseContext } from '../../db/client';

// Database client interface for token metadata update
export interface TokenMetadataUpdateClient {
  ctx: DatabaseContext<any>;
  schema: any;
}

// Update the lastUsedAt timestamp for a token
export async function updateTokenLastUsed(
  client: TokenMetadataUpdateClient,
  tokenUid: string
): Promise<void> {
  const useSqlite = isSQLite(client.ctx);
  const table = useSqlite ? client.schema.tokensSqlite : client.schema.tokens;
  await (client.ctx.db as any).update(table)
    .set({ lastUsedAt: useSqlite ? new Date().toISOString() : new Date() })
    .where(eq((table as any).uid, tokenUid));
}
