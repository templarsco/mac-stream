import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MacStreamWebSocketServer } from '../src/server/websocket.js';
import { HEALTH_INTERVAL_MS, HEALTH_TIMEOUT_MS } from '../src/shared/constants.js';
import {
	type ClipboardUpdateMessage,
	type ErrorMessage,
	type InputEventMessage,
	type ProtocolMessage,
	type SessionEndMessage,
	type SessionStartMessage,
	type StreamConfigMessage,
	type StreamControlMessage,
	parseMessage,
	serializeMessage,
} from '../src/shared/protocol.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function connectClient(port: number): Promise<WebSocket> {
	return new Promise<WebSocket>((resolve, reject) => {
		const client = new WebSocket(`ws://127.0.0.1:${port}`);
		client.once('open', () => resolve(client));
		client.once('error', reject);
	});
}

async function waitForMessage(client: WebSocket): Promise<ProtocolMessage> {
	return new Promise<ProtocolMessage>((resolve, reject) => {
		client.once('message', (data) => {
			try {
				const raw = typeof data === 'string' ? data : data.toString();
				resolve(parseMessage(raw));
			} catch (error) {
				reject(error);
			}
		});
		client.once('error', reject);
	});
}

async function waitForClose(client: WebSocket): Promise<void> {
	return new Promise<void>((resolve) => {
		client.once('close', () => resolve());
	});
}

async function expectNoMessage(client: WebSocket, timeoutMs = 150): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			client.removeAllListeners('message');
			resolve();
		}, timeoutMs);

		client.once('message', () => {
			clearTimeout(timer);
			reject(new Error('Unexpected message received'));
		});
	});
}

function asErrorMessage(message: ProtocolMessage): ErrorMessage {
	if (message.type !== 'error') {
		throw new Error(`Expected error message, got ${message.type}`);
	}

	return message;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MacStreamWebSocketServer', () => {
	let server: MacStreamWebSocketServer;
	let port: number;

	beforeEach(async () => {
		server = new MacStreamWebSocketServer({ port: 0 });
		await server.start();

		const activePort = server.getPort();
		if (!activePort) {
			throw new Error('Failed to resolve active websocket port');
		}
		port = activePort;
	});

	afterEach(async () => {
		await server.close();
	});

	it('starts and closes cleanly', async () => {
		expect(server.getClientCount()).toBe(0);
		expect(server.getClients()).toEqual([]);

		await server.close();
		expect(server.getClientCount()).toBe(0);
	});

	it('supports start/close multiple times', async () => {
		const localServer = new MacStreamWebSocketServer({ port: 0 });

		await localServer.start();
		await localServer.close();
		await localServer.start();
		await localServer.close();
	});

	it('tracks connections and disconnections', async () => {
		const connected = once(server, 'connection');
		const client = await connectClient(port);
		const [clientId] = await connected;

		expect(typeof clientId).toBe('string');
		expect(server.getClientCount()).toBe(1);
		expect(server.getClients()).toContain(clientId);

		const disconnected = once(server, 'disconnection');
		client.close();
		const [closedClientId] = await disconnected;

		expect(closedClientId).toBe(clientId);
		expect(server.getClientCount()).toBe(0);
	});

	it('tracks multiple concurrent clients', async () => {
		const conn1 = once(server, 'connection');
		const client1 = await connectClient(port);
		const [id1] = await conn1;

		const conn2 = once(server, 'connection');
		const client2 = await connectClient(port);
		const [id2] = await conn2;

		expect(server.getClientCount()).toBe(2);
		expect(new Set(server.getClients())).toEqual(new Set([id1, id2]));

		const close1 = waitForClose(client1);
		const close2 = waitForClose(client2);
		client1.close();
		client2.close();
		await close1;
		await close2;
	});

	it('routes session_start to session:start event', async () => {
		const connected = once(server, 'connection');
		const client = await connectClient(port);
		const [clientId] = await connected;

		const eventPromise = once(server, 'session:start');
		const message: SessionStartMessage = {
			type: 'session_start',
			timestamp: Date.now(),
			clientId,
			capabilities: ['video', 'clipboard'],
		};

		client.send(serializeMessage(message));

		const [payload] = await eventPromise;
		expect(payload.clientId).toBe(clientId);
		expect(payload.message.type).toBe('session_start');
		client.close();
	});

	it('routes session_end to session:end and disconnects client', async () => {
		const client = await connectClient(port);

		const eventPromise = once(server, 'session:end');
		const message: SessionEndMessage = {
			type: 'session_end',
			timestamp: Date.now(),
			reason: 'done',
		};

		client.send(serializeMessage(message));

		const [payload] = await eventPromise;
		expect(payload.message.type).toBe('session_end');
		await waitForClose(client);
		expect(server.getClientCount()).toBe(0);
	});

	it('routes clipboard_update to clipboard:update event', async () => {
		const client = await connectClient(port);
		const eventPromise = once(server, 'clipboard:update');
		const message: ClipboardUpdateMessage = {
			type: 'clipboard_update',
			timestamp: Date.now(),
			content: 'copied text',
			format: 'text',
		};

		client.send(serializeMessage(message));

		const [payload] = await eventPromise;
		expect(payload.type).toBe('clipboard_update');
		expect(payload.content).toBe('copied text');
		client.close();
	});

	it('routes clipboard_request to clipboard:request event', async () => {
		const connected = once(server, 'connection');
		const client = await connectClient(port);
		const [clientId] = await connected;

		const eventPromise = once(server, 'clipboard:request');
		client.send(
			serializeMessage({
				type: 'clipboard_request',
				timestamp: Date.now(),
			}),
		);

		const [requestingClientId] = await eventPromise;
		expect(requestingClientId).toBe(clientId);
		client.close();
	});

	it('routes input_event to input event', async () => {
		const client = await connectClient(port);
		const eventPromise = once(server, 'input');
		const message: InputEventMessage = {
			type: 'input_event',
			timestamp: Date.now(),
			event: {
				kind: 'mouse_move',
				x: 0.3,
				y: 0.8,
			},
		};

		client.send(serializeMessage(message));

		const [payload] = await eventPromise;
		expect(payload.type).toBe('input_event');
		expect(payload.event.kind).toBe('mouse_move');
		client.close();
	});

	it('routes keyframe_request to keyframe:request event', async () => {
		const connected = once(server, 'connection');
		const client = await connectClient(port);
		const [clientId] = await connected;

		const eventPromise = once(server, 'keyframe:request');
		client.send(
			serializeMessage({
				type: 'keyframe_request',
				timestamp: Date.now(),
			}),
		);

		const [requestingClientId] = await eventPromise;
		expect(requestingClientId).toBe(clientId);
		client.close();
	});

	it('routes stream_config to stream:config event', async () => {
		const client = await connectClient(port);
		const eventPromise = once(server, 'stream:config');
		const message: StreamConfigMessage = {
			type: 'stream_config',
			timestamp: Date.now(),
			width: 1920,
			height: 1080,
			fps: 60,
			bitrate: 6_000,
			codec: 'h264',
		};

		client.send(serializeMessage(message));

		const [payload] = await eventPromise;
		expect(payload.type).toBe('stream_config');
		expect(payload.codec).toBe('h264');
		client.close();
	});

	it('routes stream_control to stream:control event', async () => {
		const client = await connectClient(port);
		const eventPromise = once(server, 'stream:control');
		const message: StreamControlMessage = {
			type: 'stream_control',
			timestamp: Date.now(),
			action: 'restart',
		};

		client.send(serializeMessage(message));

		const [payload] = await eventPromise;
		expect(payload.type).toBe('stream_control');
		expect(payload.action).toBe('restart');
		client.close();
	});

	it('routes client error message to client:error event', async () => {
		const client = await connectClient(port);
		const eventPromise = once(server, 'client:error');
		const message: ErrorMessage = {
			type: 'error',
			timestamp: Date.now(),
			code: 'E_CLIENT',
			message: 'something went wrong',
		};

		client.send(serializeMessage(message));

		const [payload] = await eventPromise;
		expect(payload.type).toBe('error');
		expect(payload.code).toBe('E_CLIENT');
		client.close();
	});

	it('responds to health_ping with health_pong', async () => {
		const client = await connectClient(port);
		const responsePromise = waitForMessage(client);

		client.send(
			serializeMessage({
				type: 'health_ping',
				timestamp: Date.now(),
			}),
		);

		const response = await responsePromise;
		expect(response.type).toBe('health_pong');
		client.close();
	});

	it(
		'disconnects stale clients after HEALTH_TIMEOUT_MS',
		async () => {
			const client = await connectClient(port);
			const disconnected = once(server, 'disconnection');
			await waitForClose(client);
			await disconnected;
			expect(server.getClientCount()).toBe(0);
		},
		HEALTH_TIMEOUT_MS + HEALTH_INTERVAL_MS + 5_000,
	);

	it('broadcast sends message to all connected clients', async () => {
		const client1 = await connectClient(port);
		const client2 = await connectClient(port);

		const received1 = waitForMessage(client1);
		const received2 = waitForMessage(client2);

		server.broadcast({
			type: 'health_pong',
			timestamp: Date.now(),
		});

		const [message1, message2] = await Promise.all([received1, received2]);
		expect(message1.type).toBe('health_pong');
		expect(message2.type).toBe('health_pong');

		client1.close();
		client2.close();
	});

	it('send delivers message only to target client', async () => {
		const conn1 = once(server, 'connection');
		const client1 = await connectClient(port);
		const [clientId1] = await conn1;

		const conn2 = once(server, 'connection');
		const client2 = await connectClient(port);
		await conn2;

		const targetMessage = waitForMessage(client1);
		server.send(clientId1, {
			type: 'health_pong',
			timestamp: Date.now(),
		});

		const received = await targetMessage;
		expect(received.type).toBe('health_pong');

		await expectNoMessage(client2);

		client1.close();
		client2.close();
	});

	it('sends error response on invalid json', async () => {
		const client = await connectClient(port);
		const responsePromise = waitForMessage(client);

		client.send('{not-valid-json');

		const response = asErrorMessage(await responsePromise);
		expect(response.code).toBe('BAD_MESSAGE');
		client.close();
	});

	it('sends error response on unknown message type', async () => {
		const client = await connectClient(port);
		const responsePromise = waitForMessage(client);

		client.send(
			JSON.stringify({
				type: 'unknown',
				timestamp: Date.now(),
			}),
		);

		const response = asErrorMessage(await responsePromise);
		expect(response.code).toBe('BAD_MESSAGE');
		client.close();
	});

	it('close() disconnects all connected clients', async () => {
		const client1 = await connectClient(port);
		const client2 = await connectClient(port);

		const closed1 = waitForClose(client1);
		const closed2 = waitForClose(client2);

		await server.close();
		await Promise.all([closed1, closed2]);

		expect(server.getClientCount()).toBe(0);
	});
});
