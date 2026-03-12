/**
 * Schemas for API Token Handler
 * 
 * Contains only api-token-specific Valibot validation schemas and OpenAPI JSON schemas.
 * Core schemas (APIToken) are imported from core.
 */

import * as v from 'valibot';
import type { ObjectSchema, IntersectSchema, InferOutput, InferInput } from 'valibot';
import { toJsonSchemaDefs } from '@valibot/to-json-schema';
import { apiTokenSchema } from '../../../shared-utils/src/openapi';
import { simpleSuccessResponseSchema, errorResponseJsonSchema } from '@danylohotvianskyi/bobra-framework/batteries/openapi';

export const tokenUidParamsSchema = v.object({
  tokenUid: v.string(),
});

export const safeApiTokenSchema = v.omit(apiTokenSchema, ['tokenHash', 'tokenSalt', 'initToken']);

export const createTokenRequestSchema: ObjectSchema<any, any> = v.partial(v.pick(apiTokenSchema, ['name', 'ipAddresses', 'expiresAt']));

export const createTokenResponseDataSchema: IntersectSchema<any, any> = v.intersect([
  v.partial(v.pick(apiTokenSchema, ['uid', 'name', 'ipAddresses', 'createdAt', 'lastUsedAt', 'expiresAt'])),
  v.object({
    token: v.string(),
  })
]);

export type TokenUidParams = InferInput<typeof tokenUidParamsSchema>;
export type SafeAPIToken = InferInput<typeof safeApiTokenSchema>;
export type CreateTokenRequest = InferInput<typeof createTokenRequestSchema>;
export type CreateTokenResponseData = InferOutput<typeof createTokenResponseDataSchema>;
export type APIToken = InferOutput<typeof apiTokenSchema>;

// Component schemas for OpenAPI components section - only api-token-related schemas
export const componentSchemas = toJsonSchemaDefs({
  // API Token-specific entity schemas
  APIToken: apiTokenSchema,
  SafeAPIToken: safeApiTokenSchema,

  // API Token-specific request schemas
  CreateTokenRequest: createTokenRequestSchema,
  CreateTokenResponseData: createTokenResponseDataSchema,

  // Default responses
  SimpleSuccessResponse: simpleSuccessResponseSchema,
  ErrorResponse: errorResponseJsonSchema,
}, {
  typeMode: 'output',
  overrideRef: (context) => `#/components/schemas/${context.referenceId}`
});
