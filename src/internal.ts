import { Hono } from 'hono';

export type InternalOptions = {
	/** A Registry from @prometheus-io/client, will be served on /metrics */
	registry: { metrics(): Promise<string>; contentType: string };
	/**
	 * @default () => true
	 * Whether the app can take requests yet.
	 **/
	ready?: () => boolean | Promise<boolean>;
};

export const internal = ({ registry, ready = () => true }: InternalOptions) => {
	const routes = new Hono();

	routes.get('/alive', (c) => c.text('OK'));
	routes.get('/ready', async (c) => ((await ready()) ? c.text('OK') : c.text('Not ready', 503)));
	routes.get('/metrics', async (c) => c.body(await registry.metrics(), 200, { 'Content-Type': registry.contentType }));

	return routes;
};
