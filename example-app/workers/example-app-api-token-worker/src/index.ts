import { createCloudflareWorker, createHandlerArray } from '@danylohotvianskyi/bobra-framework/core';
import apiTokenHandler from '@example-app/api-token-handler';

export default createCloudflareWorker(
  'example-app-api-token-worker',
  createHandlerArray(apiTokenHandler)
);
