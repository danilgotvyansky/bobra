/**
 * Example App Router Worker
 *
 * Uses the shared createRouterWorker from @danylohotvianskyi/bobra-framework to avoid
 * duplicating routing, proxy, and health-check logic.
 */

import { createRouterWorker } from '@danylohotvianskyi/bobra-framework/network';

export default createRouterWorker({
	workerName: 'example-app-router-worker',

	// Here is an example how you can add custom router-level auth
	// onBeforeRoutes: (app) => {
	// 	const combinedAuth = async (c: any, next: any) => {
	// 		const authHeader = c.req.header('Authorization') || c.req.header('X-Authorization');
	// 		const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
	// 		if (token && token.startsWith('bct_') && token.length === 52) {
	// 			// Public API token – let downstream handlers validate against DB
	// 			return next();
	// 		}
	// 		const spaMiddleware = verifySpaAccessToken({ required: true });
	// 		return spaMiddleware(c, next);
	// 	};

	// 	// Apply combined auth only for root path (not for handler routes)
	// 	app.use('*', async (c, next) => {
	// 		const path = c.req.path;
	// 		if (path === '/' || path === '') {
	// 			return combinedAuth(c, next);
	// 		}
	// 		return next();
	// 	});
	// },

	// Here is an example how you can build public config with OAuth details
	// buildPublicConfig: (config, env) => {
	// 	const basePath = getRouterBasePath(config);
	// 	const workers = Object.entries(config.workers || {}).map(([name, worker]) => ({
	// 		name,
	// 		basePath: getWorkerBasePath(config, name),
	// 		handlers: worker.handlers || []
	// 	}));

	// 	const melodyAuthSPAClientID = env.MELODY_AUTH_SPA_CLIENT_ID;
	// 	if (!melodyAuthSPAClientID) {
	// 		throw new Error('MELODY_AUTH_SPA_CLIENT_ID is required in vars for public config');
	// 	}
	// 	const melodyAuthService = config.router?.services?.find((s: any) => s.binding === 'MELODY_AUTH' || s.service === 'melody-auth');
	// 	const melodyAuthUrl = env.MELODY_AUTH_URL || melodyAuthService?.external_url;

	// 	return {
	// 		router: { basePath },
	// 		workers,
	// 		oauth: {
	// 			clientId: melodyAuthSPAClientID,
	// 			serverUri: melodyAuthUrl,
	// 			scopes: env.MELODY_AUTH_SPA_SCOPES,
	// 			storage: env.MELODY_AUTH_STORAGE
	// 		}
	// 	};
	// }

});
