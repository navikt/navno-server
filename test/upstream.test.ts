// node:test's test() returns a promise the runner tracks itself
/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHttpError, isTimeoutError, type Plugin } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { isValidationError, schema, type StandardSchemaV1, ValidationError } from '@itsy/corgi/schema';
import { httpError, mockFetch, networkError } from '@itsy/corgi/testing';
import { Registry } from '@prometheus-io/client';
import { createUpstreamClient, failureOf, type UpstreamClientOptions, type UpstreamOptions } from '../src/upstream.ts';

const OFFICES = 'http://upstream.test/offices';

/** The value of one series, read from the registry the way Prometheus reads it */
const metric = async (registry: Registry, series: string) => {
	const lines = (await registry.metrics()).split('\n');
	const line = lines.find((candidate) => candidate.startsWith(`${series} `));
	return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

// An app's registry and its upstream clients, on a transport that answers what the test tells it to
const start = (options: Partial<UpstreamClientOptions> = {}) => {
	const registry = new Registry();
	const http = mockFetch();
	const upstreamClient = createUpstreamClient({ registry, prefix: 'app_', ...options });

	return {
		http,
		registry,
		client: (upstream: string, ofItsOwn: Partial<UpstreamOptions> = {}) =>
			upstreamClient(upstream, { timeout: 1000, fetch: http.fetch, ...ofItsOwn }),
		requests: (upstream: string, status: string) =>
			metric(registry, `app_upstream_requests_total{upstream="${upstream}",status="${status}"}`),
		timed: (upstream: string) =>
			metric(registry, `app_upstream_request_duration_seconds_count{upstream="${upstream}"}`),
	};
};

/** The upper bounds of the duration histogram's buckets, once a request has been timed */
const bucketsOf = async (options?: Partial<UpstreamClientOptions>) => {
	const { http, client, registry } = start(options);
	http.get(OFFICES, { json: {} });
	await client('pdl').get(OFFICES);

	return Array.from((await registry.metrics()).matchAll(/_bucket\{le="([^"]+)"/g), ([, le]) => le).join(' ');
};

// What zod and the like hand corgi: a Standard Schema. This one takes an object whose offices is a list of strings.
const Offices: StandardSchemaV1<unknown, { offices: string[] }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: (value) => {
			const { offices } = value as { offices?: unknown };
			return Array.isArray(offices) && offices.every((office) => typeof office === 'string')
				? { value: { offices } }
				: { issues: [{ message: 'expected a list of strings', path: ['offices'] }] };
		},
	},
};

test('counts and times each request under the name its client was made with', async () => {
	const { http, client, requests, timed } = start();
	http.get(OFFICES, { json: { offices: [] } });
	http.get('http://upstream.test/missing', { status: 404 });
	http.get('http://upstream.test/token', { status: 503 });
	const pdl = client('pdl');
	const texas = client('texas');

	assert.deepEqual(await pdl.get(OFFICES), { offices: [] });
	await assert.rejects(pdl.get('http://upstream.test/missing'), isHttpError);
	await assert.rejects(texas.get('http://upstream.test/token'), isHttpError);

	assert.equal(await requests('pdl', '2xx'), 1);
	assert.equal(await requests('pdl', '4xx'), 1);
	assert.equal(await timed('pdl'), 2);
	assert.equal(await requests('texas', '5xx'), 1);
	assert.equal(await timed('texas'), 1);
	assert.equal(await requests('texas', '2xx'), undefined);
});

test('counts a request that got no answer as a network error, and passes the error on', async () => {
	const { http, client, requests, timed } = start();
	http.get(OFFICES, networkError());

	await assert.rejects(client('texas').get(OFFICES), { name: 'TypeError', message: 'fetch failed' });

	assert.equal(await requests('texas', 'network_error'), 1);
	assert.equal(await timed('texas'), 1);
});

test('gives up on an upstream that takes longer than its timeout, and counts that', async () => {
	const { http, client, requests, timed } = start();
	http.get(OFFICES, { hang: true });

	await assert.rejects(client('pdl', { timeout: 20 }).get(OFFICES), isTimeoutError);

	assert.equal(await requests('pdl', 'timeout'), 1);
	assert.equal(await timed('pdl'), 1);
});

test('counts each attempt on its own when the app retries', async () => {
	const { http, client, requests, timed } = start();
	http.get(OFFICES, [{ status: 503 }, { json: { offices: [] } }]);

	await client('norg', { plugins: [withRetry({ retries: 1, backoff: 0 })] }).get(OFFICES);

	assert.equal(await requests('norg', '5xx'), 1);
	assert.equal(await requests('norg', '2xx'), 1);
	assert.equal(await timed('norg'), 2);
});

test('throws when an answer fails its schema, though the request itself went fine', async () => {
	const { http, client, requests } = start();
	http.get(OFFICES, { json: { offices: 'none' } });

	await assert.rejects(client('pdl').get(OFFICES, { transform: schema(Offices) }), isValidationError);

	assert.equal(await requests('pdl', '2xx'), 1);
});

test('keeps the options and the plugins the app gives a client', async () => {
	const { http, client, requests } = start();
	http.get(OFFICES, { json: {} });
	const asked: string[] = [];
	const noting: Plugin = (next) => (url, init) => {
		asked.push(url);
		return next(url, init);
	};

	await client('xp', {
		baseURL: 'http://upstream.test',
		headers: { accept: 'application/json' },
		plugins: [noting],
	}).get('/offices');

	assert.equal(http.lastCall?.headers.get('accept'), 'application/json');
	assert.deepEqual(asked, [OFFICES]);
	assert.equal(await requests('xp', '2xx'), 1);
});

test('names its metrics with the prefix, in the registry it was given', async () => {
	const { registry } = start({ prefix: 'nav_office_search_api_' });

	const metrics = await registry.metrics();

	assert.match(metrics, /^# TYPE nav_office_search_api_upstream_requests_total counter$/m);
	assert.match(metrics, /^# TYPE nav_office_search_api_upstream_request_duration_seconds histogram$/m);
});

test("takes the histogram's buckets from the app, and goes from 10 ms to 30 s when it gives none", async () => {
	assert.equal(await bucketsOf({ buckets: [0.005, 0.5] }), '0.005 0.5 +Inf');
	assert.equal(await bucketsOf(), '0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 10 30 +Inf');
});

test('failureOf gives only the status of an HttpError, whose message, URL and data can be about a person', () => {
	const error = httpError(503, { error: 'PDL svarte ikke' }, { url: 'http://pdl-api.test/graphql?q=storgata+1' });

	assert.deepEqual(failureOf(error), { status: 503 });
});

test('failureOf gives where and why an answer failed its schema, for the first three places', () => {
	const error = new ValidationError([
		{ message: 'expected string, received number', path: ['offices', 0, { key: 'enhetNr' }] },
		{ message: 'expected string', path: ['offices', 1, 'navn'] },
		{ message: 'required', path: ['total'] },
		{ message: 'required', path: ['page'] },
	]);

	assert.deepEqual(failureOf(error), {
		issues: [
			'offices.0.enhetNr: expected string, received number',
			'offices.1.navn: expected string',
			'total: required',
		],
	});
});

test('failureOf passes other errors on, for the logger to show', () => {
	const error = new TypeError('fetch failed');

	assert.equal(failureOf(error), error);
	assert.deepEqual(failureOf('oops'), { error: 'oops' });
});
