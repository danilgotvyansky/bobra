/**
 * API Docs Handler for Example App
 * 
 * This handler:
 * - Dynamically discovers and collects OpenAPI specifications from all handlers
 * - Serves Swagger UI, Scalar API Reference and Markdown for LLMs
 */
import { Hono, type Context } from 'hono';
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
import { createMarkdownFromOpenApi } from '@scalar/openapi-to-markdown';

type HandlerContext = Context<{ Bindings: Record<string, unknown> }>;
type ApiDocsRoutes = AppHandler['routes'] & {
  get: (path: string, handler: unknown) => ApiDocsRoutes;
};

interface LlmsCacheEntry {
  markdown: string;
  expiresAt: number;
  pathCount: number;
}

const DEFAULT_LLMS_SCALAR_TIMEOUT_MS = 12000;
const LLMS_CACHE_TTL_MS = 60000;

let llmsCache: LlmsCacheEntry | null = null;
let llmsRenderInFlight: Promise<LlmsCacheEntry> | null = null;

function getOpenApiPathCount(openapi: Record<string, unknown>): number {
  const paths = openapi.paths;
  return isObjectRecord(paths) ? Object.keys(paths).length : 0;
}

function getLlmsScalarTimeoutMs(env: Env): number {
  const configuredTimeout = Number(env.LLMS_SCALAR_TIMEOUT_MS || DEFAULT_LLMS_SCALAR_TIMEOUT_MS);
  return Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_LLMS_SCALAR_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function buildMergedOpenApiDocument(c: HandlerContext): Promise<Record<string, unknown>> {
  const env = c.env as Env;
  const discovery = (c.get as (key: string) => unknown)('serviceDiscovery');
  const handlerNames = collectHandlerNames(discovery);

  getLogger().debug('OpenAPI merge: handlers selected', { handlers: Array.from(handlerNames) });

  const handlerNameList = Array.from(handlerNames);
  const results = await Promise.allSettled(
    handlerNameList.map(async (name) => {
      try {
        const res = await serviceFetch(env, name, '/openapi', {}, c);
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
    .map((r, i) => ({ r, name: handlerNameList[i] }))
    .filter(x => x.r.status === 'rejected' || x.r.value == null)
    .map(x => x.name);

  getLogger().debug('OpenAPI merge: collected specs', { count: specs.length, failed });

  const merged = mergeOpenApiSpecs(specs, {
    title: 'Example App API',
    description: 'API documentation',
    version: '1.0.0',
  });
  getLogger().debug('OpenAPI merge: merged done', { pathCount: getOpenApiPathCount(merged) });

  return merged;
}

const routes: AppHandler['routes'] = (new Hono<{ Bindings: Record<string, unknown> }>() as ApiDocsRoutes)
  // Return merged OpenAPI spec across all handlers
  .get('/openapi', async (c: HandlerContext) => {
    const merged = await buildMergedOpenApiDocument(c);
    return c.json(merged, 200);
  })

  .get('/swagger', swaggerUI({ url: 'openapi' }))

  .get('/scalar', Scalar({ url: 'openapi' }))


  /**
   * Register a route to serve the Markdown for LLMs
   * @see https://llmstxt.org/
   */
  .get('/llms.txt', async (c: HandlerContext) => {
    const now = Date.now();
    if (llmsCache && llmsCache.expiresAt > now) {
      return c.text(llmsCache.markdown, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-LLMS-Cache': 'hit',
        'X-LLMS-Renderer': 'scalar',
        'X-LLMS-Path-Count': String(llmsCache.pathCount),
      });
    }

    const env = c.env as Env;
    const markdownTimeoutMs = getLlmsScalarTimeoutMs(env);

    if (!llmsRenderInFlight) {
      llmsRenderInFlight = (async () => {
        const openapi = await buildMergedOpenApiDocument(c);
        const pathCount = getOpenApiPathCount(openapi);
        if (pathCount === 0) {
          throw new Error('Merged OpenAPI has zero paths');
        }

        const markdown = await withTimeout(
          createMarkdownFromOpenApi(openapi),
          markdownTimeoutMs,
          'llms.txt markdown generation'
        );

        return {
          markdown,
          expiresAt: Date.now() + LLMS_CACHE_TTL_MS,
          pathCount,
        };
      })().finally(() => {
        llmsRenderInFlight = null;
      });
    }

    try {
      const entry = await llmsRenderInFlight;
      llmsCache = entry;
      return c.text(entry.markdown, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-LLMS-Cache': 'miss',
        'X-LLMS-Renderer': 'scalar',
        'X-LLMS-Path-Count': String(entry.pathCount),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn('llms.txt failed to render from merged OpenAPI', { error: message });
      const isPathIssue = message.includes('zero paths');
      return c.text(
        isPathIssue
          ? 'OpenAPI paths are temporarily unavailable. Please retry.'
          : 'Failed to render llms.txt from OpenAPI. Please retry.',
        503,
        {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-LLMS-Cache': 'miss',
          'X-LLMS-Renderer': 'scalar',
          'X-LLMS-Path-Count': isPathIssue ? '0' : 'unknown',
        }
      );
    }
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
