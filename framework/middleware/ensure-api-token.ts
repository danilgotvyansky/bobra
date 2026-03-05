import type { TokenValidationProvider } from '../batteries/auth/token-validation';
import { validateToken, extractAuthToken } from '../batteries/auth/token-validation';

export interface EnsureApiTokenOptions {
  getTokenValidationProvider: (c: any) => TokenValidationProvider;
  getOrgContext?: (c: any) => Promise<string | null> | string | null;
  verifyTokenScope?: (env: any, orgContext: string, tokenId: string) => Promise<boolean>;
}

export function ensureApiToken(options: EnsureApiTokenOptions) {
  return async (c: any, next: any) => {
    const env = c.env as any;

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

        const isLinked = await options.verifyTokenScope(env, orgContext as string, result.tokenInfo.id);
        if (!isLinked) {
          return c.json({ valid: false, reason: 'Token is not linked to this organization' }, 403);
        }
      }
    }

    c.set('apiToken', result.tokenInfo);
    await next();
  };
}
