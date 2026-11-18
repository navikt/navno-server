import { traceRoute } from '@navikt/navno-logger';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

/**
 * Makes Nais OpenTelemetry work
 *
 * @example
 * `app.use(traceRoutes())`
 */
export const traceRoutes = (): MiddlewareHandler => async (c, next) => {
	await next();
	// After the handlers, when Hono knows which route answered
	traceRoute(routePath(c));
};
