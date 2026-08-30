import { Hono } from 'hono';
import type { AppHandler } from '@danylohotvianskyi/bobra-framework/core';
import { createObservabilityMetricsProvider } from '@danylohotvianskyi/bobra-framework/batteries/metrics';

/** The framework mounts the configured metrics endpoint; this handler has no public routes. */
const observabilityHandler: AppHandler = {
	name: 'observability',
	version: '1.0.0',
	routes: new Hono() as AppHandler['routes'],
	metrics: createObservabilityMetricsProvider(),
};

export default observabilityHandler;
