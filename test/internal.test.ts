// node:test's test() returns a promise the runner tracks itself
/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Counter, Registry } from '@prometheus-io/client';
import { Hono } from 'hono';
import { internal } from '../src/internal.ts';

// An app's own registry, with one of its metrics
const registry = new Registry();
new Counter({ name: 'searches_total', help: 'Searches made', registers: [registry] }).inc(3);

const appWith = (options: Partial<Parameters<typeof internal>[0]> = {}) =>
	new Hono().route('/internal', internal({ registry, ...options }));

test('/alive answers 200', async () => {
	const response = await appWith().request('/internal/alive');

	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'OK');
});

test('/ready answers 200 when the app has nothing to wait for', async () => {
	assert.equal((await appWith().request('/internal/ready')).status, 200);
});

test('/ready answers 503 until ready() is true, while /alive answers 200', async () => {
	let loaded = false;
	const app = appWith({ ready: () => loaded });

	assert.equal((await app.request('/internal/ready')).status, 503);
	assert.equal((await app.request('/internal/alive')).status, 200);

	loaded = true;

	assert.equal((await app.request('/internal/ready')).status, 200);
});

test('ready() can answer with a promise', async () => {
	assert.equal((await appWith({ ready: async () => false }).request('/internal/ready')).status, 503);
	assert.equal((await appWith({ ready: async () => true }).request('/internal/ready')).status, 200);
});

test("a ready() that throws is answered by the app's own onError", async () => {
	const app = appWith({
		ready: () => {
			throw new Error('The database is gone');
		},
	}).onError((error, c) => c.text(error.message, 500));

	const response = await app.request('/internal/ready');

	assert.equal(response.status, 500);
	assert.equal(await response.text(), 'The database is gone');
});

test("/metrics serves the app's registry as Prometheus reads it", async () => {
	const response = await appWith().request('/internal/metrics');

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), registry.contentType);
	assert.match(await response.text(), /^searches_total 3$/m);
});

test('the routes are where the app mounts them', async () => {
	const app = new Hono().basePath('/sok').route('/api/internal', internal({ registry }));

	assert.equal((await app.request('/sok/api/internal/alive')).status, 200);
	assert.equal((await app.request('/internal/alive')).status, 404);
});
