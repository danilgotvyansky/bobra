import { Hono } from 'hono';
import { getLogger, initializeLogger } from '../logging/logger';
import type { AppHandler } from './discovery';

// Basic environment type for SPA handler
interface SpaEnv {
  [key: string]: any;
}

export interface SpaHandlerOptions {
  /**
   * Name of the handler. Used for logging and discovery.
   * Also used as the base path for matching (e.g. /name/*).
   */
  name: string;
  /**
   * Version of the handler.
   */
  version?: string;
  /**
   * Name of the file to serve for SPA routes (default: 'index.html').
   */
  indexHtml?: string;
  /**
   * Name of the binding for assets (default: 'ASSETS').
   */
  assetsBinding?: string;
  /**
   * Whether to ignore the worker's base path for routing.
   */
  ignoreWorkerBasePath?: boolean;
}

/**
 * Creates a reusable handler for serving a Single Page Application (SPA).
 * Handles asset serving, recursion guarding, and SPA fallback.
 */
export function createSpaHandler(options: SpaHandlerOptions): AppHandler {
  const {
    name,
    version = '0.1.0',
    indexHtml = 'index.html',
    assetsBinding = 'ASSETS',
    ignoreWorkerBasePath = false
  } = options;

  const app = new Hono<{ Bindings: SpaEnv }>();

  // Handle all requests under this handler's path
  app.all('*', async (c) => {
    const logger = getLogger();
    const url = new URL(c.req.url);

    const ASSETS = c.env[assetsBinding] as any;
    if (!ASSETS) {
      logger.error(`${assetsBinding} binding not available within SpaHandler '${name}'`);
      return c.text(`${assetsBinding} binding not available`, 503);
    }

    // Recursion guard: prevent infinite loops when ASSETS routes back to the handler
    if (c.req.header('X-Recursive-Fetch') === 'true') {
      return new Response(null, { status: 404 });
    }

    // File heuristic: if path has an extension, serve as static asset
    const isFile = url.pathname.match(/\.[a-zA-Z0-9]+$/);

    if (isFile) {
      const assetRequest = new Request(c.req.url, c.req.raw);
      assetRequest.headers.set('X-Recursive-Fetch', 'true');

      const response = await ASSETS.fetch(assetRequest);

      return response;
    }

    // SPA fallback: serve index.html for all non-file routes
    let indexPath = indexHtml || 'index.html';
    if (!indexPath.startsWith('/')) {
      indexPath = `/${name}/${indexPath}`;
    }

    const indexUrl = new URL(url);
    indexUrl.pathname = indexPath;

    const indexRequest = new Request(indexUrl, c.req.raw);
    indexRequest.headers.set('X-Recursive-Fetch', 'true');

    const response = await ASSETS.fetch(indexRequest);

    if (response.status !== 200) {
      logger.error(`[SpaHandler:${name}] Failed to fetch ${indexPath}. Status: ${response.status}`);
    }

    return response;
  });

  return {
    name,
    version,
    ignoreWorkerBasePath,
    routes: app,
    initLogger: (config, context, worker, handler) => {
      initializeLogger(config, context, worker);
      if (handler) getLogger().setHandler(handler);
    },
    init: async (_env) => { }
  };
}
