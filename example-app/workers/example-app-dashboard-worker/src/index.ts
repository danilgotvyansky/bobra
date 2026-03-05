/**
 * Example Dashboard Worker
 *
 * Demonstrates how to serve a frontend SPA using the Bobra framework's
 * createSpaHandler. The ASSETS binding is configured via wrangler.jsonc
 * to serve files from the frontend's dist/ directory.
 */

import { createCloudflareWorker, createHandlerArray, createSpaHandler } from '@bobra/framework/core';

// Serve the dashboard frontend at /dashboard/*
const dashboardHandler = createSpaHandler({
  name: 'dashboard',
  indexHtml: 'index.html',
  assetsBinding: 'ASSETS',
  ignoreWorkerBasePath: true
});

export default createCloudflareWorker('example-dashboard-worker', createHandlerArray(
  dashboardHandler
));
