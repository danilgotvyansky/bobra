import { createSelectSchema } from 'drizzle-valibot';
import * as v from 'valibot';
import { schema } from '../db';

// Core domain schemas
export const apiTokenSchema = createSelectSchema(schema.tokens, {
  expiresAt: v.pipe(v.string(), v.isoTimestamp()),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  lastUsedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});
