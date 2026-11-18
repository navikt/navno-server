// Required bot-reading before changing anything: docs/graceful-shutdown.md.
import type { Server, ServerOptions } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve as listen } from '@hono/node-server';
import { logger } from '@navikt/navno-logger';

// This number is the max of Nais' ingress, login-sidecar, and Wonderwall, plus some small buffer
const KEEP_ALIVE_TIMEOUT_MS = 15_000;

// Close connections to a pod after 1s
const CLOSE_DELAY_MS = 1_000;

// k8s gives a pod 30s to stop, Nais pauses before SIGTERM for 5s, our KeepAlive is 15s so just pin this to 10s.
const DRAIN_TIMEOUT_MS = 10_000;

// How often a server that has stopped listening closes the connections that have gone idle
const SWEEP_INTERVAL_MS = 50;

export type ServeOptions = {
	/** The port to listen on */
	port: number;
	/** The address to listen on, will listen on all addresses when omitted */
	hostname?: string;
	/**
	 * Stop timers and watchers here. Note that requests are still being answered while this runs
	 */
	onShutdown?: () => void | Promise<void>;
	/**
	 * @default 1s
	 * How long the server goes on answering after the signal before it stops listening
	 */
	closeDelay?: number;
	/**
	 * @default 10s
	 * How long the server has to drop connections after it gets the stop-signal
	 */
	drainTimeout?: number;
	/** Node's options for the server. A keepAliveTimeout here will replace the 15s default. */
	serverOptions?: ServerOptions;
	/** False keeps Node's own Request and Response, which @hono/node-server otherwise replaces with faster ones */
	overrideGlobalObjects?: boolean;
};

export const serve = (app: { fetch: Parameters<typeof listen>[0]['fetch'] }, options: ServeOptions): Server => {
	const {
		port,
		hostname,
		onShutdown,
		closeDelay = CLOSE_DELAY_MS,
		drainTimeout = DRAIN_TIMEOUT_MS,
		serverOptions,
		overrideGlobalObjects,
	} = options;

	const server = listen(
		{
			fetch: app.fetch,
			port,
			hostname,
			overrideGlobalObjects,
			serverOptions: { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS, ...serverOptions },
		},
		(info) => logger.info('Server listening', { port: info.port })
	) as Server;

	// A failing onShutdown is logged, and doesn't keep the server from stopping
	const runOnShutdown = async () => {
		try {
			await onShutdown?.();
		} catch (e) {
			logger.error('onShutdown failed', e);
		}
	};

	let stopping = false;

	const shutdown = async (signal: NodeJS.Signals) => {
		if (stopping) return;
		stopping = true;
		logger.info('Server shutting down', { signal });

		setTimeout(() => {
			logger.warn('Shutdown timed out, exiting anyway', { drainTimeout });
			process.exit(1);
		}, drainTimeout).unref();

		const hookDone = runOnShutdown();

		// The server responds with Connection: close from here on, and Node closes the connection once it is sent.
		server.prependListener('request', (_request, response) => {
			response.setHeader('Connection', 'close');
		});
		await sleep(closeDelay);

		// Stops listening, and ends the connections that are idle
		const closed = new Promise((resolve) => server.close(resolve));
		// This handles requests that started before the above `prependListener` hook
		const sweep = setInterval(() => server.closeIdleConnections(), SWEEP_INTERVAL_MS);

		await Promise.all([closed, hookDone]);
		clearInterval(sweep);
		logger.info('Shutdown complete');
		process.exit(0);
	};

	process.once('SIGTERM', (signal) => void shutdown(signal));
	process.once('SIGINT', (signal) => void shutdown(signal));

	return server;
};
