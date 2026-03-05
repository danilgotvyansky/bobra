import { eq } from 'drizzle-orm';

// Database client interface for token metadata update
export interface TokenMetadataUpdateClient {
  db: any;
  schema: any;
  sql: any;
}

// Update the lastUsedAt timestamp for a token
export async function updateTokenLastUsed(
  client: TokenMetadataUpdateClient,
  tokenId: string
): Promise<void> {
  const useSqlite = !!(client as any).useSqlite;
  const table = useSqlite ? client.schema.tokensSqlite : client.schema.tokens;
  await client.db.update(table)
    .set({ lastUsedAt: useSqlite ? new Date().toISOString() : new Date() })
    .where(eq((table as any).uid, tokenId));
}
