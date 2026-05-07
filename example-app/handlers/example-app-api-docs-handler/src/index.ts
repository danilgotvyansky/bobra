/**
 * API Docs Handler for Example App
 * 
 * This handler:
 * - Dynamically discovers and collects OpenAPI specifications from all handlers
 * - Serves Swagger UI, Scalar API Reference and Markdown for LLMs
 */
import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import {
  getLogger,
  initializeLogger
} from '@danylohotvianskyi/bobra-framework/logging';
import { serviceFetch } from '@danylohotvianskyi/bobra-framework/network';
import type { AppHandler } from '@danylohotvianskyi/bobra-framework/core';
import {
  mergeOpenApiSpecs,
  collectHandlerNames,
  isObjectRecord
} from '@danylohotvianskyi/bobra-framework/batteries/openapi';
import type { Env } from './types';
import { Scalar } from '@scalar/hono-api-reference';
import { createMarkdownFromOpenApi } from '@scalar/openapi-to-markdown'

const routes: AppHandler['routes'] = new Hono<{ Bindings: Record<string, unknown> }>()
  // Return merged OpenAPI spec across all handlers
  .get('/openapi', async (c) => {
    const env = c.env as Env;
    const discovery = (c.get as (key: string) => unknown)('serviceDiscovery');
    const handlerNames = collectHandlerNames(discovery);

    getLogger().debug('OpenAPI merge: handlers selected', { handlers: Array.from(handlerNames) });

    const results = await Promise.allSettled(
      Array.from(handlerNames).map(async (name) => {
        try {
          const res = await serviceFetch(env, name, '/openapi');
          getLogger().debug('OpenAPI merge: serviceFetch returned', { target: name, ok: res.ok, status: res.status });
          if (!res.ok) throw new Error(`status ${res.status}`);
          return await res.json();
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          getLogger().warn(`Failed to fetch OpenAPI for handler '${name}'`, {
            error: e.message,
            stack: e.stack
          });
          return null;
        }
      })
    );

    const specs = results
      .map(r => (r.status === 'fulfilled' ? r.value : null))
      .filter(Boolean);

    const failed = results
      .map((r, i) => ({ r, name: Array.from(handlerNames)[i] }))
      .filter(x => x.r.status === 'rejected' || x.r.value == null)
      .map(x => x.name);

    getLogger().debug('OpenAPI merge: collected specs', { count: specs.length, failed });

    const merged = mergeOpenApiSpecs(specs, {
      title: 'Example App API',
      description: 'API documentation',
      version: '1.0.0',
    });
    getLogger().debug('OpenAPI merge: merged done', { pathCount: Object.keys(merged.paths || {}).length });
    return c.json(merged, 200);
  })

  .get('/swagger', swaggerUI({ url: 'openapi' }))

  .get('/scalar', Scalar({ url: 'openapi' }))


  /**
   * Register a route to serve the Markdown for LLMs
   * @see https://llmstxt.org/
   */
  .get('/llms.txt', async (c) => {
    const url = new URL('openapi', c.req.url);
    const res = await fetch(url.toString());
    if (!res.ok) return c.text(`Failed to load OpenAPI (${res.status})`, 502);

    const openapi: unknown = await res.json();
    if (!isObjectRecord(openapi)) {
      return c.text('Invalid OpenAPI payload', 502);
    }

    const markdown = await createMarkdownFromOpenApi(openapi);
    return c.text(markdown, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  })
  ;

// Create the handler
const apiDocsHandler: AppHandler = {
  name: 'api-docs',
  version: '0.1.0',
  routes,
  initLogger: (config, context, worker, handler) => {
    initializeLogger(config, context, worker);
    if (handler) getLogger().setHandler(handler);
  },
  init: async (_env) => { }
};

export default apiDocsHandler;
