import { createCloudflareWorker, createHandlerArray } from '@danylohotvianskyi/bobra-framework/core';
import apiDocsHandler from '@example-app/api-docs-handler';

export default createCloudflareWorker(
  'example-app-api-docs-worker',
  createHandlerArray(apiDocsHandler)
);
