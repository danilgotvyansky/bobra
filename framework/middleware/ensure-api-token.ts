import type { TokenValidationProvider } from '../batteries/auth/token-validation';
import { validateToken, extractAuthToken } from '../batteries/auth/token-validation';
import { Context } from 'hono';
import type { RouterEnv } from '../network/router';

export interface EnsureApiTokenOptions {
  getTokenValidationProvider: (c: Context<{ Bindings: RouterEnv; Variables: { _apiTokenFromQuery?: string; apiToken?: unknown } }>) => TokenValidationProvider;
  getOrgContext?: (c: Context<{ Bindings: RouterEnv; Variables: { _apiTokenFromQuery?: string; apiToken?: unknown } }>) => Promise<string | null> | string | null;
  verifyTokenScope?: (env: RouterEnv, orgContext: string, tokenUid: string) => Promise<boolean>;
}

export function ensureApiToken(options: EnsureApiTokenOptions) {
  return async (c: Context<{ Bindings: RouterEnv; Variables: { _apiTokenFromQuery?: string; apiToken?: unknown } }>, next: () => Promise<void>) => {
    const env = c.env;

    let rawToken = extractAuthToken(c.req.raw as Request);

    if (!rawToken) {
      const tokenFromContext = c.get('_apiTokenFromQuery');
      if (tokenFromContext && typeof tokenFromContext === 'string') {
        rawToken = tokenFromContext;
      }
    }

    if (!rawToken) {
      return c.json({ valid: false, reason: 'Authorization header missing or malformed' }, 401);
    }

    const provider = options.getTokenValidationProvider(c);
    const result = await validateToken(rawToken, provider);

    if (!result.valid || !result.tokenInfo) {
      return c.json({ valid: false, reason: result.reason || 'Unauthorized' }, result.reason === 'Token not found' ? 404 : 401);
    }

    const isInit = !!result.tokenInfo.initToken;
    if (!isInit) {
      if (options.getOrgContext && options.verifyTokenScope) {
        const orgContext = await options.getOrgContext(c) || (c.req.header('X-Org-Context') || c.req.query('org_uid'));
        if (!orgContext) {
          return c.json({ valid: false, reason: 'Organization context required' }, 400);
        }

        const isLinked = await options.verifyTokenScope(env, orgContext, result.tokenInfo.uid);
        if (!isLinked) {
          return c.json({ valid: false, reason: 'Token is not linked to this organization' }, 403);
        }
      }
    }

    c.set('apiToken', result.tokenInfo);
    await next();
  };
}
