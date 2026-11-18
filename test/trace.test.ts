// node:test's test() returns a promise the runner tracks itself
/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { context, type ContextManager, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { getRPCMetadata, RPCType, setRPCMetadata } from '@opentelemetry/core';
import { Hono } from 'hono';
import { traceRoutes } from '../src/trace.ts';

// What the agent's HTTP instrumentation keeps for a request, made with the real packages as navno-logger's tests do,
// and a context manager that is always in that request
let request = ROOT_CONTEXT;

beforeEach(() => {
	const span = trace.wrapSpanContext({
		traceId: '0af7651916cd43dd8448eb211c80319c',
		spanId: 'b7ad6b7169203331',
		traceFlags: 1,
	});
	request = setRPCMetadata(ROOT_CONTEXT, { type: RPCType.HTTP, span });
	const manager = { active: () => request, disable: () => undefined };
	context.setGlobalContextManager(manager as unknown as ContextManager);
});

afterEach(() => context.disable());

const tracedRoute = () => getRPCMetadata(request)?.route;

const app = new Hono()
	.use(traceRoutes())
	.get('/users/:id', (c) => c.text(c.req.param('id')))
	.route(
		'/internal',
		new Hono().get('/alive', (c) => c.text('OK'))
	);

test("names the trace after the route's pattern, not the path that was asked for", async () => {
	await app.request('/users/42');

	assert.equal(tracedRoute(), '/users/:id');
});

test('a route in a mounted app has the path it is mounted on', async () => {
	await app.request('/internal/alive');

	assert.equal(tracedRoute(), '/internal/alive');
});

test('the paths no route takes share one name', async () => {
	await app.request('/wp-login.php');
	const first = tracedRoute();
	await app.request('/.env');

	assert.equal(first, '/*');
	assert.equal(tracedRoute(), '/*');
});
