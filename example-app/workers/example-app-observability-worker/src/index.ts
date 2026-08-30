import { DurableObject } from 'cloudflare:workers';
import { createCloudflareWorker, createHandlerArray } from '@danylohotvianskyi/bobra-framework/core';
import { createBobraMetricsCoordinatorClass, type MetricsDurableObjectConstructor } from '@danylohotvianskyi/bobra-framework/batteries/metrics';
import observabilityHandler from '@example-app/observability-handler';

export class BobraMetricsCoordinator extends createBobraMetricsCoordinatorClass(DurableObject as unknown as MetricsDurableObjectConstructor) {}

export default createCloudflareWorker('example-app-observability-worker', createHandlerArray(observabilityHandler));
