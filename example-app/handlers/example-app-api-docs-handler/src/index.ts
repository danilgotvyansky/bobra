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
} from '@bobra/framework/logging';
import { serviceFetch } from '@bobra/framework/network';
import type { AppHandler } from '@bobra/framework/core';
import { mergeOpenApiSpecs } from '@bobra/framework/batteries/openapi';
import type { Env, ServiceDiscovery } from './types';
import { Scalar } from '@scalar/hono-api-reference';
import { createMarkdownFromOpenApi } from '@scalar/openapi-to-markdown'

const routes = new Hono()
  // Return merged OpenAPI spec across all handlers
  .get('/openapi', async (c: any) => {
    const env = c.env as Env;
    const discovery = c.get('serviceDiscovery') as any as ServiceDiscovery & { allWorkers?: Record<string, { handlers: string[] }> };

    // Collect unique handler names from discovery (all workers)
    const handlerNames = new Set<string>();
    const allWorkers = (discovery as any)?.allWorkers || {};
    for (const [, worker] of Object.entries(allWorkers)) {
      const handlers: any[] = (worker as any)?.handlers || [];
      for (const handlerName of handlers) {
        // Skip api-docs itself to avoid self-inclusion if desired
        if (handlerName && handlerName !== 'api-docs') handlerNames.add(handlerName);
      }
    }

    // Fallback: if discovery lacks allWorkers, try initializedHandlers on current worker
    if (handlerNames.size === 0 && Array.isArray((discovery as any)?.initializedHandlers)) {
      for (const name of (discovery as any).initializedHandlers) handlerNames.add(name);
    }

    getLogger().debug('OpenAPI merge: handlers selected', { handlers: Array.from(handlerNames) });

    const results = await Promise.allSettled(
      Array.from(handlerNames).map(async (name) => {
        try {
          const res = await serviceFetch(env, name, '/openapi', {}, c);
          getLogger().debug('OpenAPI merge: serviceFetch returned', { target: name, ok: res.ok, status: res.status });
          if (!res.ok) throw new Error(`status ${res.status}`);
          return await res.json();
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          getLogger().warn(`Failed to fetch OpenAPI for handler '${name}'`, e);
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
  .get('/llms.txt', async (c: any) => {
    const url = new URL('openapi', c.req.url);
    const headers: Record<string, string> = {};
    const auth = c.req.header('Authorization');
    const orgCtx = c.req.header('X-Org-Context');
    if (auth) headers['Authorization'] = auth;
    if (orgCtx) headers['X-Org-Context'] = orgCtx;

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) return c.text('Failed to load OpenAPI', res.status);

    const openapi = await res.json();
    const markdown = await createMarkdownFromOpenApi(openapi as any);
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
