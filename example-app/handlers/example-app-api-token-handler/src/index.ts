import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { vValidator } from '@hono/valibot-validator';
import { InferInput } from 'valibot';
import { initializeLogger, getLogger } from '@danylohotvianskyi/bobra-framework/logging';
import { ensureApiToken } from '@danylohotvianskyi/bobra-framework/middleware';
import type { AppHandler, WorkerEnv } from '@danylohotvianskyi/bobra-framework/core';
import { getDatabaseContext } from '@danylohotvianskyi/bobra-framework/db';
import { schema } from '../../../shared-utils/src/db';
import {
  createTokenRequestSchema,
  componentSchemas,
  tokenUidParamsSchema
} from './schemas';
import {
  generateSchemaRef,
  generateListResponseSchema,
  generateResponseSchema
} from '@danylohotvianskyi/bobra-framework/batteries/openapi';
import { deleteToken, getToken, listTokens } from './db-utils';
import { createToken } from './service';

const routes = new Hono()
  .use('*', ensureApiToken({
    getTokenValidationProvider: (c: any) => {
      const ctx = getDatabaseContext(c.env, schema);
      return {
        ctx,
        schema
      } as any;
    }
  }))

  .get(
    '/',
    describeRoute({
      description: 'List API tokens',
      responses: {
        200: {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: generateListResponseSchema('SafeAPIToken')
            }
          },
        },
      },
    }),
    async (c: any) => {
      const env = c.env as WorkerEnv;
      const tokens = await listTokens(env);
      const filtered = (tokens as any[])
        .filter(t => !(t.initToken === true || t.initToken === 1))
        .map(t => {
          const { initToken, ...rest } = t;
          return rest;
        });
      return c.json({ success: true, data: filtered });
    }
  )
  .get(
    '/:tokenUid',
    describeRoute({
      description: 'Get a single API token by ID',
      responses: {
        200: {
          description: 'Successful response',
          content: { 'application/json': { schema: generateResponseSchema('SafeAPIToken') } },
        },
        404: {
          description: 'Token not found',
          content: { 'application/json': { schema: generateSchemaRef('ErrorResponse') } },
        },
        500: {
          description: 'Failed to get token',
          content: { 'application/json': { schema: generateSchemaRef('ErrorResponse') } },
        },
      },
    }),
    vValidator('param', tokenUidParamsSchema),
    async (c: any) => {
      try {
        const env = c.env as WorkerEnv;
        const tokenUid = c.req.valid('param').tokenUid;
        const token = await getToken(env, tokenUid);
        const { initToken, tokenHash, tokenSalt, ...rest } = token as any;
        return c.json({ success: true, data: rest });
      } catch (error) {
        getLogger().error('Failed to get token', error instanceof Error ? error : new Error(String(error)));
        const errorMessage = error instanceof Error ? error.message : String(error);
        return c.json({
          success: false,
          error: errorMessage.includes('not found') ? 'Token not found' : 'Failed to get token'
        }, errorMessage.includes('not found') ? 404 : 500);
      }
    }
  )
  .post(
    '/',
    describeRoute({
      description: 'Create a new API token',
      requestBody: {
        content: {
          'application/json': {
            schema: generateSchemaRef('CreateTokenRequest'),
          },
        },
      },
      responses: {
        201: {
          description: 'Token created',
          content: { 'application/json': { schema: generateSchemaRef('CreateTokenResponseData') } },
        },
        400: {
          description: 'Invalid request body',
          content: { 'application/json': { schema: generateSchemaRef('ErrorResponse') } },
        },
      },
    }),
    vValidator('json', createTokenRequestSchema),
    async (c: any) => {
      const env = c.env as WorkerEnv;
      const body = c.req.valid('json') as InferInput<typeof createTokenRequestSchema>;
      return await createToken(body, env);
    }
  )
  .delete(
    '/:tokenUid',
    describeRoute({
      description: 'Delete an API token by ID',
      responses: {
        200: {
          description: 'Token deleted',
          content: { 'application/json': { schema: generateSchemaRef('SimpleSuccessResponse') } },
        },
        404: {
          description: 'Token not found',
          content: { 'application/json': { schema: generateSchemaRef('ErrorResponse') } },
        },
        500: {
          description: 'Failed to delete token',
          content: { 'application/json': { schema: generateSchemaRef('ErrorResponse') } },
        },
      },
    }),
    vValidator('param', tokenUidParamsSchema),
    async (c: any) => {
      const env = c.env as WorkerEnv;
      const tokenUid = c.req.valid('param').tokenUid;
      try {
        const result = await deleteToken(env, tokenUid);

        if (!result.found) {
          return c.json({ success: false, error: 'Token not found' }, 404);
        }

        return c.json({ success: true });
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        getLogger().error('Error deleting token', err);
        return c.json(
          { success: false, error: 'Failed to delete token' },
          500
        );
      }
    }
  );

const exampleAppApiTokenHandler: AppHandler = {
  name: 'api-token',
  version: '0.1.0',
  routes,
  componentSchemas: componentSchemas,
  initLogger: (config, context, worker, handler) => {
    initializeLogger(config, context, worker);
    if (handler) getLogger().setHandler(handler);
  },
  init: async (_env) => { }
};

export default exampleAppApiTokenHandler;
