import { eq } from 'drizzle-orm';
import { 
  isSQLiteContext,
  isPostgresContext,
  type DatabaseContext,
  type DrizzleSchema,
  type TokenSchemaBindings
} from '../../db/client';


// Database client interface for token metadata update
export interface TokenMetadataUpdateClient {
  ctx: DatabaseContext<DrizzleSchema>;
  schema: TokenSchemaBindings;
}

// Update the lastUsedAt timestamp for a token
export async function updateTokenLastUsed(
  client: TokenMetadataUpdateClient,
  tokenUid: string
): Promise<void> {
  if (isSQLiteContext(client.ctx)) {
    await client.ctx.db.update(client.schema.tokensSqlite)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(client.schema.tokensSqlite.uid, tokenUid));
    return;
  }

  if (isPostgresContext(client.ctx)) {
    await client.ctx.db.update(client.schema.tokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(client.schema.tokens.uid, tokenUid));
    return;
  }

  throw new Error('Unsupported database context type');
}
