// node:test's test() returns a promise the runner tracks itself
/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./serve.fixture.ts', import.meta.url));

type Log = { level: string; message: string; [field: string]: unknown };

// Starts serve.fixture.ts as a process of its own, since a signal and an exit are only real from outside. What the
// server does is read from its log, which is JSON lines in production. The close delay is 50 ms instead of 1 s, and
// the drain timeout 3 s instead of 10, so a server that fails to stop fails its test without the wait.
//
// The logger doesn't wait for a line to be written, and what it still holds at the exit is written ahead of a line on
// its way out. So the last lines before an exit can change places, and no test relies on their order.
const start = async (t: TestContext, env: Record<string, string> = {}) => {
	const child = spawn(process.execPath, [FIXTURE], {
		env: { PATH: process.env.PATH, NODE_ENV: 'production', CLOSE_DELAY: '50', DRAIN_TIMEOUT: '3000', ...env },
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	t.after(() => child.kill('SIGKILL'));

	const logs: Log[] = [];
	const seen = new EventEmitter();
	const lines = createInterface(child.stdout).on('line', (line) => {
		const log = JSON.parse(line) as Log;
		logs.push(log);
		seen.emit(log.message);
	});

	/** Resolves once the server has logged the message */
	const logged = async (message: string) => {
		if (!logs.some((log) => log.message === message)) {
			await once(seen, message);
		}
	};

	/** The exit code, once the process is gone and all it logged is read */
	const exit = Promise.all([once(child, 'close'), once(lines, 'close')]).then(([[code]]) => code as number | null);

	await Promise.race([
		logged('Server listening'),
		exit.then((code) => Promise.reject(new Error(`The server exited with ${code} before it listened`))),
	]);
	const port = logs.find((log) => log.message === 'Server listening')?.port as number;

	// One connection, kept open between requests, as a proxy keeps its connections to a pod
	const keptAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
	t.after(() => keptAlive.destroy());

	type Answer = { status?: number; headers: http.IncomingHttpHeaders; body: string; reusedConnection: boolean };

	/** A request on the kept-alive connection, or on a new connection of its own */
	const get = (path: string, { newConnection = false } = {}) =>
		new Promise<Answer>((resolve, reject) => {
			const req = http
				.get({ host: '127.0.0.1', port, path, agent: newConnection ? false : keptAlive }, (res) => {
					let body = '';
					res
						.setEncoding('utf-8')
						.on('data', (chunk: string) => (body += chunk))
						.on('end', () =>
							resolve({ status: res.statusCode, headers: res.headers, body, reusedConnection: req.reusedSocket })
						);
				})
				.on('error', reject);
		});

	return {
		get,
		logs,
		logged,
		exit,
		messages: () => logs.map((log) => log.message),
		signal: (signal: NodeJS.Signals) => child.kill(signal),
	};
};

test('keeps idle connections for 15 s, and says so in its answers', async (t) => {
	const server = await start(t);

	const { status, headers } = await server.get('/');

	assert.equal(status, 200);
	assert.equal(headers['keep-alive'], 'timeout=15');
});

test('serverOptions replaces the keep-alive timeout', async (t) => {
	const server = await start(t, { KEEP_ALIVE_TIMEOUT: '3000' });

	assert.equal((await server.get('/')).headers['keep-alive'], 'timeout=3');
});

test('overrideGlobalObjects is passed on to @hono/node-server', async (t) => {
	const byDefault = await start(t);
	const turnedOff = await start(t, { OVERRIDE_GLOBAL_OBJECTS: 'false' });

	assert.equal((await byDefault.get('/globals')).body, '{"overridden":true}');
	assert.equal((await turnedOff.get('/globals')).body, '{"overridden":false}');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	test(`on ${signal}, answers the request in progress and then exits with 0`, async (t) => {
		// The request's connection is kept alive, and stays open after the answer. A server that waited for it to close
		// would still be there when the drain timeout runs out, and exit with 1.
		const server = await start(t);

		const answer = server.get('/slow/500');
		await server.logged('Request received');
		server.signal(signal);

		assert.equal((await answer).status, 200);
		assert.equal(await server.exit, 0);
		assert.deepEqual(server.messages().slice(0, 3), ['Server listening', 'Request received', 'Server shutting down']);
		assert.equal(server.logs[2].signal, signal);
		assert.ok(server.messages().includes('Shutdown complete'));
	});
}

test('exits when no request is in progress, though a connection is open', async (t) => {
	const server = await start(t);

	await server.get('/');
	server.signal('SIGTERM');

	assert.equal(await server.exit, 0);
});

test('goes on answering during the close delay, and each answer tells its client to close the connection', async (t) => {
	const server = await start(t, { CLOSE_DELAY: '1000' });

	// The kept-alive connection is open and idle when the signal comes
	assert.equal((await server.get('/')).headers.connection, 'keep-alive');
	server.signal('SIGTERM');
	await server.logged('Server shutting down');

	// It is still there, and its next request is answered as before, apart from the header
	const answer = await server.get('/');
	assert.equal(answer.status, 200);
	assert.equal(answer.reusedConnection, true);
	assert.equal(answer.headers.connection, 'close');
	assert.equal(answer.headers['keep-alive'], undefined);

	// So is a request on a connection the server hasn't seen before
	assert.equal((await server.get('/', { newConnection: true })).status, 200);
	assert.equal(await server.exit, 0);
});

test('takes no new connections once the close delay is over', async (t) => {
	const server = await start(t);

	let answered = false;
	const answer = server.get('/slow/1000').finally(() => (answered = true));
	await server.logged('Request received');
	server.signal('SIGTERM');

	// Refused within the second the request in progress takes, so by a server that is still there
	await server.logged('Server shutting down');
	const refusal = async (): Promise<string | undefined> => {
		try {
			await server.get('/', { newConnection: true });
		} catch (e) {
			return (e as NodeJS.ErrnoException).code;
		}
		await sleep(20);
		return refusal();
	};
	assert.equal(await refusal(), 'ECONNREFUSED');
	assert.equal(answered, false);
	assert.equal((await answer).status, 200);
});

test('a second signal changes nothing', async (t) => {
	const server = await start(t);

	const answer = server.get('/slow/500');
	await server.logged('Request received');
	server.signal('SIGTERM');
	await server.logged('Server shutting down');
	server.signal('SIGINT');

	assert.equal((await answer).status, 200);
	assert.equal(await server.exit, 0);
	assert.equal(server.messages().filter((message) => message === 'Server shutting down').length, 1);
});

test('cuts off a request that outlasts the drain timeout, and exits with 1', async (t) => {
	const server = await start(t, { DRAIN_TIMEOUT: '200' });

	const answer = server.get('/slow/10000');
	await server.logged('Request received');
	server.signal('SIGTERM');

	await assert.rejects(answer, { code: 'ECONNRESET' });
	assert.equal(await server.exit, 1);
	const warning = server.logs.find((log) => log.message === 'Shutdown timed out, exiting anyway');
	assert.partialDeepStrictEqual(warning, { level: 'warn', drainTimeout: 200 });
	assert.ok(!server.messages().includes('Shutdown complete'));
});

test('calls onShutdown when it begins to stop, before the requests in progress are answered', async (t) => {
	const server = await start(t, { ON_SHUTDOWN: 'logs' });

	const answer = server.get('/slow/500');
	await server.logged('Request received');
	server.signal('SIGTERM');
	await answer;
	await server.exit;

	// Half a second apart, so in the order they were logged
	const messages = server.messages();
	assert.ok(messages.includes('onShutdown ran'));
	assert.ok(messages.indexOf('onShutdown ran') < messages.indexOf('Request answered'), messages.join(', '));
});

test('waits for an onShutdown that takes time before it exits', async (t) => {
	const server = await start(t, { ON_SHUTDOWN: 'slow' });

	server.signal('SIGTERM');

	assert.equal(await server.exit, 0);
	// Logged when the wait is over, which a server that had exited wouldn't get to
	assert.ok(server.messages().includes('onShutdown ran'));
});

test('gives up on an onShutdown that never finishes when the drain timeout runs out', async (t) => {
	const server = await start(t, { ON_SHUTDOWN: 'hangs', DRAIN_TIMEOUT: '200' });

	server.signal('SIGTERM');

	assert.equal(await server.exit, 1);
	assert.ok(server.messages().includes('Shutdown timed out, exiting anyway'));
});

test('logs an onShutdown that fails, and stops all the same', async (t) => {
	const server = await start(t, { ON_SHUTDOWN: 'throws' });

	server.signal('SIGTERM');

	assert.equal(await server.exit, 0);
	const failure = server.logs.find((log) => log.level === 'error');
	assert.equal(failure?.message, 'onShutdown failed');
	assert.partialDeepStrictEqual(failure.err, { message: 'The watcher is already closed' });
});
