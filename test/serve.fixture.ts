// The server serve.test.ts starts, as a process of its own. Its environment picks what a test needs of serve()'s options.
import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from '@navikt/navno-logger';
import { Hono } from 'hono';
import { serve } from '../src/serve.ts';

const { CLOSE_DELAY, DRAIN_TIMEOUT, KEEP_ALIVE_TIMEOUT, ON_SHUTDOWN, OVERRIDE_GLOBAL_OBJECTS } = process.env;

const NodesResponse = globalThis.Response;

const app = new Hono()
	.get('/', (c) => c.text('OK'))
	// Answers after as many milliseconds as the path says, and logs both ends so a test can tell where it is
	.get('/slow/:ms', async (c) => {
		logger.info('Request received');
		await sleep(Number(c.req.param('ms')));
		logger.info('Request answered');
		return c.text('OK');
	})
	// Whether @hono/node-server has put its own Response in place of Node's
	.get('/globals', (c) => c.json({ overridden: globalThis.Response !== NodesResponse }));

const onShutdown: Record<string, () => void | Promise<void>> = {
	logs: () => logger.info('onShutdown ran'),
	slow: async () => {
		await sleep(300);
		logger.info('onShutdown ran');
	},
	throws: () => {
		throw new Error('The watcher is already closed');
	},
	hangs: () => new Promise<void>(() => {}),
};

serve(app, {
	// Any free port. The test reads which from the log
	port: 0,
	hostname: '127.0.0.1',
	closeDelay: CLOSE_DELAY ? Number(CLOSE_DELAY) : undefined,
	drainTimeout: DRAIN_TIMEOUT ? Number(DRAIN_TIMEOUT) : undefined,
	onShutdown: ON_SHUTDOWN ? onShutdown[ON_SHUTDOWN] : undefined,
	serverOptions: KEEP_ALIVE_TIMEOUT ? { keepAliveTimeout: Number(KEEP_ALIVE_TIMEOUT) } : undefined,
	overrideGlobalObjects: OVERRIDE_GLOBAL_OBJECTS ? OVERRIDE_GLOBAL_OBJECTS === 'true' : undefined,
});
