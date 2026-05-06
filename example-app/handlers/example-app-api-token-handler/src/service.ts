/**
 * Service Layer Functions for API Token Handler
 * 
 * Contains all business logic for token operations, separated from HTTP concerns.
 */

import type { WorkerEnv } from '@danylohotvianskyi/bobra-framework/core';
import { getLogger } from '@danylohotvianskyi/bobra-framework/logging';
import { createPublicApiToken } from '@danylohotvianskyi/bobra-framework/batteries/auth';
import { insertToken } from './db-utils';
import { createTokenRequestSchema, CreateTokenResponseData } from './schemas';
import { parse, type InferInput } from 'valibot';
import { apiTokenSchema } from '@example-app/shared-utils/src/openapi';

export async function createToken(body: InferInput<typeof createTokenRequestSchema>, env: WorkerEnv): Promise<Response> {
  try {
    // Convert expiresAt to timestamp if provided
    let expiresAtTimestamp: number | undefined;
    if (body.expiresAt) {
      expiresAtTimestamp = typeof body.expiresAt === 'string' ? new Date(body.expiresAt).getTime() : body.expiresAt;
      // Validate that expiresAt is in the future
      if (expiresAtTimestamp !== undefined && expiresAtTimestamp <= Date.now()) {
        return new Response(JSON.stringify({ success: false, error: 'expiresAt must be in the future' }), { headers: { 'Content-Type': 'application/json' }, status: 400 });
      }
    }

    const { token, record } = await createPublicApiToken({
      name: body.name ?? undefined,
      ...(expiresAtTimestamp !== undefined && { expiresAt: expiresAtTimestamp }),
      ipAddresses: Array.isArray(body.ipAddresses) ? body.ipAddresses : undefined
    });

    const validatedRecord = parse(apiTokenSchema, record);
    await insertToken(env, validatedRecord);

    const res: CreateTokenResponseData = { uid: record.uid, token };
    return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' }, status: 201 });
  } catch (error) {
    getLogger().error('Error creating API token', error instanceof Error ? error : new Error(String(error)));
    return new Response(JSON.stringify({ success: false, error: 'Failed to create token' }), { status: 500 });
  }
}
