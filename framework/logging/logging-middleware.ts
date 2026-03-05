import type { Context, Next } from 'hono';
import { getLogger } from './logger';
import { loadConfig, getWorkerBasePath } from '../core/config';

export interface HonoLoggerOptions {
  /**
   * Custom function to extract the path to log
   * Useful for logging original URLs when behind a proxy
   */
  getPath?: (c: Context) => string;

  /**
   * Custom function to extract additional metadata
   */
  getMetadata?: (c: Context) => Record<string, any>;

  /**
   * Skip logging for certain paths (e.g., health checks)
   */
  skipPaths?: string[];

  /**
   * Skip logging for certain HTTP methods
   */
  skipMethods?: string[];

  /**
   * Log request body (logs after processing)
   */
  logRequestBody?: boolean;

  /**
   * Log response body
   */
  logResponseBody?: boolean;


  /**
   * Log incoming request (logs before processing)
   */
  logIncomingRequest?: boolean;

  /**
   * Maximum body size to log (in bytes)
   */
  maxBodySize?: number;

  /**
   * Log request headers
   */
  logHeaders?: boolean;
}

const defaultOptions: HonoLoggerOptions = {
  getPath: (c) => {
    const originalUrl = c.req.header('X-Forwarded-Url');
    if (originalUrl) {
      try {
        const url = new URL(originalUrl);
        return url.pathname + url.search;
      } catch {
        // Fallback to request path if URL is invalid
      }
    }
    const url = new URL(c.req.url);
    return url.pathname + url.search;
  },
  getMetadata: () => ({}),
  skipPaths: [],
  skipMethods: [],
  logRequestBody: false,
  logResponseBody: false,
  maxBodySize: 1024 * 10, // 10KB default
  logIncomingRequest: false,
  logHeaders: false
};

/**
 * Helper to set up logger context from environment config
 */
async function setupLoggerContext(c: Context, path: string) {
  const logger = getLogger();
  try {
    const envAny = c.env as any;
    const workerName = envAny?.WORKER_NAME as string | undefined;

    // config access is safe here because loadConfig handles decompression/caching
    if (workerName && envAny?.CONFIG_CONTENT) {
      const config = await loadConfig(envAny);
      const basePath = getWorkerBasePath(config, workerName);
      const handlers = config.workers?.[workerName]?.handlers || [];
      const handlerNames = new Set<string>(handlers);

      let relative = path;
      if (basePath && basePath !== '/' && relative.startsWith(basePath)) {
        relative = relative.slice(basePath.length) || '/';
      }
      // Strip query params for handler matching
      const pathOnly = (relative && relative.split) ? (relative.split('?')[0] ?? '') : '';
      const seg = (pathOnly || '').split('/').filter(Boolean)[0];
      if (seg && handlerNames.has(seg)) {
        logger.setHandler?.(seg);
      } else {
        logger.setHandler?.('');
      }
    } else {
      logger.setHandler?.('');
    }
  } catch { }
}

/**
 * Hono middleware for logging HTTP requests using the universal logger
 * Extends Hono's native logger middleware
 */
export function honoLogger(options: HonoLoggerOptions = {}) {
  const opts = { ...defaultOptions, ...options };

  // Body logger middleware logic
  const logBody = async (c: Context, next: Next) => {
    const method = c.req.method;
    const path = opts.getPath!(c);

    // Skip logging if configured
    if (opts.skipPaths?.includes(path) || opts.skipMethods?.includes(method)) {
      await next();
      return;
    }

    await setupLoggerContext(c, path);

    // Prepare request metadata
    const baseMetadata = {
      userAgent: c.req.header('User-Agent'),
      ip: c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP'),
      referer: c.req.header('Referer'),
      ...opts.getMetadata!(c)
    };

    // Log incoming request if enabled
    if (opts.logIncomingRequest) {
      getLogger().info(`<-- ${method} ${path}`, baseMetadata);
    }

    // Log request body if enabled
    let requestBody: any = undefined;
    if (opts.logRequestBody && ['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        const contentType = c.req.header('Content-Type');
        if (contentType?.includes('application/json')) {
          const body = await c.req.text();
          if (body.length <= (opts.maxBodySize || 0)) {
            requestBody = JSON.parse(body);
          }
        }
      } catch (error) {
        // Ignore body parsing errors
      }
    }

    const start = Date.now();
    await next();
    const ms = Date.now() - start;

    // Log response body if enabled
    let responseBody: any = undefined;
    if (opts.logResponseBody && c.res.body) {
      try {
        const contentType = c.res.headers.get('Content-Type');
        if (contentType?.includes('application/json')) {
          const response = c.res.clone();
          const body = await response.text();
          if (body.length <= (opts.maxBodySize || 0)) {
            responseBody = JSON.parse(body);
          }
        }
      } catch (error) {
        // Ignore response body parsing errors
      }
    }

    // Access Log
    const status = c.res.status;
    const headers: Record<string, string> = {};

    if (opts.logHeaders) {
      c.req.raw.headers.forEach((v, k) => {
        headers[k] = v;
      });
    }

    getLogger().request(method, path, status, ms, {
      ...baseMetadata,
      headers: opts.logHeaders ? headers : undefined,
      requestBody,
      responseBody
    });
  };

  return logBody;
}

/**
 * Simple Hono logger middleware with minimal configuration
 * Equivalent to the built-in Hono logger but using our universal logger
 */
export function simpleHonoLogger(config?: { logRequestBody?: boolean; logResponseBody?: boolean; logIncomingRequest?: boolean; logHeaders?: boolean }) {
  return honoLogger({
    skipPaths: ['/health', '/favicon.ico'],
    getMetadata: () => ({}),
    logRequestBody: config?.logRequestBody,
    logResponseBody: config?.logResponseBody,
    logIncomingRequest: config?.logIncomingRequest,
    logHeaders: config?.logHeaders
  });
}

/**
 * Detailed Hono logger middleware with request/response body logging
 * Use with caution in production due to performance and security implications
 */
export function detailedHonoLogger() {
  return honoLogger({
    skipPaths: ['/health', '/favicon.ico'],
    logRequestBody: true,
    logResponseBody: true,
    maxBodySize: 1024 * 5, // 5KB
    getMetadata: (c) => ({
      query: Object.fromEntries(new URL(c.req.url).searchParams.entries()),
    })
  });
}
