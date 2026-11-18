// What Node's own HTTP server does, which serve() is written around and docs/shutdown.md refers to. None of this is
// serve()'s doing: when a test here fails, Node has changed, and serve() and the document can change with it.
//
// node:test's test() returns a promise the runner tracks itself
/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const REQUEST = 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n';

/** A server on a free port that answers OK, after as many milliseconds as said */
const start = async (t: TestContext, options: http.ServerOptions, answerAfter = 0) => {
	const server = http.createServer(options, async (_request, response) => {
		await sleep(answerAfter);
		response.end('OK');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address() as AddressInfo;
	t.after(() => {
		server.close();
		server.closeAllConnections();
	});

	/** A connection of its own, as a proxy holds one to a pod */
	const connect = async () => {
		const socket = net.connect(port, '127.0.0.1');
		// A reset is what one of the tests is about. It shows as the connection closing
		socket.on('error', () => {});
		t.after(() => socket.destroy());
		await once(socket, 'connect');
		return socket;
	};

	return { server, connect };
};

/** What comes on the connection, up to and including the text */
const read = (socket: net.Socket, until: string) =>
	new Promise<string>((resolve, reject) => {
		let received = '';
		socket.on('data', (chunk: Buffer) => {
			received += chunk.toString();
			if (received.includes(until)) resolve(received);
		});
		socket.once('close', () => reject(new Error(`The connection closed after ${JSON.stringify(received)}`)));
	});

/** The answer to one request on the connection */
const request = async (socket: net.Socket) => {
	const answer = read(socket, '\r\n\r\nOK');
	socket.write(REQUEST);
	return answer;
};

test('headersTimeout times a request whose headers have begun to arrive, not an idle connection', async (t) => {
	// A headersTimeout far below keepAliveTimeout, checked every 50 ms instead of every 30 s
	const { connect } = await start(t, { keepAliveTimeout: 5000, headersTimeout: 300, connectionsCheckingInterval: 50 });

	// Idle for more than three times headersTimeout between two requests, and still open
	const idle = await connect();
	assert.match(await request(idle), /^HTTP\/1\.1 200 /);
	await sleep(1000);
	assert.match(await request(idle), /^HTTP\/1\.1 200 /);

	// The timeout is in force all the while: a request whose headers stop coming is answered 408 and cut
	const stalled = await connect();
	const answer = read(stalled, '\r\n\r\n');
	stalled.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
	assert.match(await answer, /^HTTP\/1\.1 408 /);
	await once(stalled, 'close');
});

test('close() leaves a connection that was answering open, and it takes requests until its keep-alive timeout', async (t) => {
	const { server, connect } = await start(t, { keepAliveTimeout: 1000 }, 100);

	const socket = await connect();
	const answer = request(socket);
	await once(server, 'request');
	let closedAt = 0;
	server.close(() => (closedAt = performance.now()));

	assert.match(await answer, /^HTTP\/1\.1 200 /);
	const answeredAt = performance.now();

	// The server has stopped listening, and the connection still takes a request
	await assert.rejects(connect(), { code: 'ECONNREFUSED' });
	await sleep(300);
	assert.match(await request(socket), /^HTTP\/1\.1 200 /);
	assert.equal(closedAt, 0);

	// close() is done when the connection has been idle for the keep-alive timeout, counted from the last answer
	await once(server, 'close');
	assert.ok(closedAt - answeredAt >= 300 + 1000, `close() took ${Math.round(closedAt - answeredAt)} ms`);
});

test('closeIdleConnections() ends such a connection once its request is answered', async (t) => {
	const { server, connect } = await start(t, { keepAliveTimeout: 1000 }, 100);

	const socket = await connect();
	const answer = request(socket);
	await once(server, 'request');
	const closed = once(server, 'close');
	server.close();

	// Not while the request is in progress
	server.closeIdleConnections();
	assert.match(await answer, /^HTTP\/1\.1 200 /);
	const answeredAt = performance.now();

	server.closeIdleConnections();
	await closed;
	assert.ok(performance.now() - answeredAt < 500, 'close() waited for the keep-alive timeout');
});

test('a request sent as the server closes its idle connection gets no answer', async (t) => {
	const { server, connect } = await start(t, { keepAliveTimeout: 5000 });

	const socket = await connect();
	assert.match(await request(socket), /^HTTP\/1\.1 200 /);

	// Sent in the same turn as the close, so before the client can have seen it: what a client does that picks the
	// connection for its next request just as the server stops
	server.closeIdleConnections();
	await assert.rejects(request(socket), { message: 'The connection closed after ""' });
});

test('an answer with Connection: close ends its connection, where close() has been called or not', async (t) => {
	const { server, connect } = await start(t, { keepAliveTimeout: 1000 });
	server.prependListener('request', (_request, response) => response.setHeader('Connection', 'close'));

	const socket = await connect();
	const closed = once(socket, 'close');
	const answeredAt = performance.now();
	assert.match(await request(socket), /\r\nConnection: close\r\n/);

	await closed;
	assert.ok(performance.now() - answeredAt < 500, 'the connection stayed open for the keep-alive timeout');
});
