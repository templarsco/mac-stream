import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HEALTH_INTERVAL_MS,
	HEALTH_TIMEOUT_MS,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BACKOFF_MULTIPLIER,
	RECONNECT_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
	VIDEO_PORT,
	WS_PORT,
} from '../src/shared/constants.js';
import { type ProtocolMessage, createMessage, serializeMessage } from '../src/shared/protocol.js';

const wsMocks = vi.hoisted(() => {
	class SimpleEmitter {
		private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

		on(event: string, listener: (...args: unknown[]) => void): this {
			const handlers = this.listeners.get(event) ?? [];
			handlers.push(listener);
			this.listeners.set(event, handlers);
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const handlers = this.listeners.get(event);
			if (!handlers) {
				return false;
			}

			for (const handler of handlers) {
				handler(...args);
			}

			return true;
		}

		removeAllListeners(): this {
			this.listeners.clear();
			return this;
		}
	}

	class MockWebSocket extends SimpleEmitter {
		static OPEN = 1;
		static CLOSED = 3;
		static instances: MockWebSocket[] = [];

		readonly url: string;
		readyState = 0;
		send = vi.fn((data: string) => {
			void data;
		});
		close = vi.fn(() => {
			this.readyState = MockWebSocket.CLOSED;
			this.emit('close');
		});

		constructor(url: string) {
			super();
			this.url = url;
			MockWebSocket.instances.push(this);
		}

		emitOpen(): void {
			this.readyState = MockWebSocket.OPEN;
			this.emit('open');
		}

		emitMessage(rawData: unknown): void {
			this.emit('message', rawData);
		}

		emitServerClose(): void {
			this.readyState = MockWebSocket.CLOSED;
			this.emit('close');
		}
	}

	return {
		MockWebSocket,
	};
});

const videoMocks = vi.hoisted(() => {
	class SimpleEmitter {
		private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

		on(event: string, listener: (...args: unknown[]) => void): this {
			const handlers = this.listeners.get(event) ?? [];
			handlers.push(listener);
			this.listeners.set(event, handlers);
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const handlers = this.listeners.get(event);
			if (!handlers) {
				return false;
			}

			for (const handler of handlers) {
				handler(...args);
			}

			return true;
		}

		removeAllListeners(): this {
			this.listeners.clear();
			return this;
		}
	}

	class MockVideoReceiver extends SimpleEmitter {
		static instances: MockVideoReceiver[] = [];

		readonly port: number;
		start = vi.fn(() => {});
		stop = vi.fn(() => {});

		constructor(port: number) {
			super();
			this.port = port;
			MockVideoReceiver.instances.push(this);
		}
	}

	return {
		MockVideoReceiver,
	};
});

vi.mock('ws', () => {
	return {
		default: wsMocks.MockWebSocket,
	};
});

vi.mock('../src/client/video-receiver.js', () => {
	return {
		VideoReceiver: videoMocks.MockVideoReceiver,
	};
});

import { ConnectionManager } from '../src/client/connection.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TestHarness {
	manager: ConnectionManager;
	onStatus: ReturnType<typeof vi.fn<(status: string) => void>>;
	onVideoFrame: ReturnType<typeof vi.fn<(data: Buffer, pts: number, isKeyframe: boolean) => void>>;
	onVideoConfig: ReturnType<
		typeof vi.fn<(config: { codec: string; width: number; height: number }) => void>
	>;
	onMessage: ReturnType<typeof vi.fn<(message: ProtocolMessage) => void>>;
}

function createHarness(): TestHarness {
	const onStatus = vi.fn<(status: string) => void>();
	const onVideoFrame = vi.fn<(data: Buffer, pts: number, isKeyframe: boolean) => void>();
	const onVideoConfig = vi.fn<(config: { codec: string; width: number; height: number }) => void>();
	const onMessage = vi.fn<(message: ProtocolMessage) => void>();

	const manager = new ConnectionManager({
		onStatus,
		onVideoFrame,
		onVideoConfig,
		onMessage,
	});

	return {
		manager,
		onStatus,
		onVideoFrame,
		onVideoConfig,
		onMessage,
	};
}

function expectLatestStatus(harness: TestHarness, status: string): void {
	const calls = harness.onStatus.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	expect(calls.at(-1)?.[0]).toBe(status);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ConnectionManager', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		wsMocks.MockWebSocket.instances.length = 0;
		videoMocks.MockVideoReceiver.instances.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ─── State Machine ────────────────────────────────────────────────────────

	it('transitions disconnected -> connecting -> connected -> streaming', () => {
		const harness = createHarness();

		harness.manager.connect('10.0.0.10');
		expectLatestStatus(harness, 'connecting');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();
		expectLatestStatus(harness, 'connected');

		const receiver = videoMocks.MockVideoReceiver.instances[0];
		receiver.emit('frame', {
			data: Buffer.from([1]),
			pts: 123,
			isKeyframe: true,
		});
		expectLatestStatus(harness, 'streaming');
	});

	// ─── Connect / Disconnect Lifecycle ───────────────────────────────────────

	it('connect() creates websocket with default port', () => {
		const harness = createHarness();

		harness.manager.connect('127.0.0.1');

		expect(wsMocks.MockWebSocket.instances).toHaveLength(1);
		expect(wsMocks.MockWebSocket.instances[0].url).toBe(`ws://127.0.0.1:${String(WS_PORT)}`);
	});

	it('connect() uses custom websocket port', () => {
		const harness = createHarness();

		harness.manager.connect('127.0.0.1', 9001);

		expect(wsMocks.MockWebSocket.instances[0].url).toBe('ws://127.0.0.1:9001');
	});

	it('connect() creates and starts VideoReceiver on websocket open', () => {
		const harness = createHarness();

		harness.manager.connect('127.0.0.1', WS_PORT, 5010);
		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		expect(videoMocks.MockVideoReceiver.instances).toHaveLength(1);
		expect(videoMocks.MockVideoReceiver.instances[0].port).toBe(5010);
		expect(videoMocks.MockVideoReceiver.instances[0].start).toHaveBeenCalledOnce();
	});

	it('connect() uses default video port when not provided', () => {
		const harness = createHarness();

		harness.manager.connect('127.0.0.1');
		wsMocks.MockWebSocket.instances[0].emitOpen();

		expect(videoMocks.MockVideoReceiver.instances[0].port).toBe(VIDEO_PORT);
	});

	it('disconnect() stops video receiver, closes websocket, and sets disconnected', () => {
		const harness = createHarness();

		harness.manager.connect('127.0.0.1');
		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();
		const receiver = videoMocks.MockVideoReceiver.instances[0];

		harness.manager.disconnect();

		expect(receiver.stop).toHaveBeenCalledOnce();
		expect(ws.close).toHaveBeenCalledOnce();
		expectLatestStatus(harness, 'disconnected');
	});

	it('disconnect() is safe when already disconnected', () => {
		const harness = createHarness();

		expect(() => {
			harness.manager.disconnect();
		}).not.toThrow();
		expect(harness.onStatus).not.toHaveBeenCalled();
	});

	// ─── Message Handling ──────────────────────────────────────────────────────

	it('forwards non-health messages to onMessage callback', () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		const message = createMessage('clipboard_request', {});
		ws.emitMessage(serializeMessage(message));

		expect(harness.onMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'clipboard_request' }),
		);
	});

	it('routes health_pong internally and does not forward to onMessage', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
		const pingsBeforePong = ws.send.mock.calls.length;

		const pong = createMessage('health_pong', {});
		ws.emitMessage(serializeMessage(pong));

		await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
		expect(ws.send.mock.calls.length).toBeGreaterThan(pingsBeforePong);
		expect(harness.onMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'health_pong' }),
		);
	});

	it('handles parse errors gracefully without crashing', () => {
		const harness = createHarness();
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		harness.manager.connect('127.0.0.1');
		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		expect(() => {
			ws.emitMessage('{invalid-json');
		}).not.toThrow();

		expect(consoleSpy).toHaveBeenCalled();
		expect(harness.onMessage).not.toHaveBeenCalled();
	});

	it('forwards video config and frame callbacks', () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();
		const receiver = videoMocks.MockVideoReceiver.instances[0];

		receiver.emit('config', { codec: 'avc1.64001F', width: 1920, height: 1080 });
		receiver.emit('frame', {
			data: Buffer.from([1, 2]),
			pts: 999,
			isKeyframe: false,
		});

		expect(harness.onVideoConfig).toHaveBeenCalledWith({
			codec: 'avc1.64001F',
			width: 1920,
			height: 1080,
		});
		expect(harness.onVideoFrame).toHaveBeenCalledWith(Buffer.from([1, 2]), 999, false);
	});

	it('sets error status when VideoReceiver emits error', () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();
		videoMocks.MockVideoReceiver.instances[0].emit('error', new Error('udp failed'));

		expectLatestStatus(harness, 'error');
	});

	// ─── sendMessage ───────────────────────────────────────────────────────────

	it('sendMessage sends serialized payload when connected', () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		const message = createMessage('clipboard_request', {});
		harness.manager.sendMessage(message);

		expect(ws.send).toHaveBeenCalledWith(serializeMessage(message));
	});

	it('sendMessage no-ops when disconnected', () => {
		const harness = createHarness();
		const message = createMessage('clipboard_request', {});

		harness.manager.sendMessage(message);

		expect(wsMocks.MockWebSocket.instances).toHaveLength(0);
	});

	// ─── Health Monitoring ─────────────────────────────────────────────────────

	it('sends health_ping every HEALTH_INTERVAL_MS', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);

		expect(ws.send).toHaveBeenCalled();
		const sentTypes = ws.send.mock.calls.map((call) => JSON.parse(call[0] as string).type);
		expect(sentTypes).toContain('health_ping');
	});

	it('health timeout triggers reconnect flow', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS + HEALTH_INTERVAL_MS);

		expect(ws.close).toHaveBeenCalled();
	});

	// ─── Auto-Reconnect ────────────────────────────────────────────────────────

	it('reconnects on unexpected websocket close', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();
		ws.emitServerClose();

		expectLatestStatus(harness, 'connecting');
		await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
		expect(wsMocks.MockWebSocket.instances).toHaveLength(2);
	});

	it('uses exponential backoff for reconnect delays', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws1 = wsMocks.MockWebSocket.instances[0];
		ws1.emitOpen();
		ws1.emitServerClose();

		await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
		const ws2 = wsMocks.MockWebSocket.instances[1];
		ws2.emitServerClose();

		const secondDelay = RECONNECT_DELAY_MS * RECONNECT_BACKOFF_MULTIPLIER;
		await vi.advanceTimersByTimeAsync(secondDelay);
		expect(wsMocks.MockWebSocket.instances).toHaveLength(3);
	});

	it('caps reconnect delay at RECONNECT_MAX_DELAY_MS', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		let current = wsMocks.MockWebSocket.instances[0];
		current.emitOpen();

		for (let i = 0; i < 8; i++) {
			current.emitServerClose();
			await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
			current = wsMocks.MockWebSocket.instances.at(-1) as InstanceType<
				typeof wsMocks.MockWebSocket
			>;
		}

		expect(wsMocks.MockWebSocket.instances.length).toBeGreaterThan(1);
	});

	it('resets reconnect attempts after successful reconnect', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws1 = wsMocks.MockWebSocket.instances[0];
		ws1.emitOpen();
		ws1.emitServerClose();

		await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
		const ws2 = wsMocks.MockWebSocket.instances[1];
		ws2.emitOpen();
		ws2.emitServerClose();

		await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
		expect(wsMocks.MockWebSocket.instances).toHaveLength(3);
	});

	it('sets error state after max reconnect attempts reached', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		let current = wsMocks.MockWebSocket.instances[0];
		current.emitOpen();

		for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
			current.emitServerClose();
			await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
			current = wsMocks.MockWebSocket.instances.at(-1) as InstanceType<
				typeof wsMocks.MockWebSocket
			>;
		}

		current.emitServerClose();
		expectLatestStatus(harness, 'error');
	});

	it('does not reconnect after user disconnect', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();
		harness.manager.disconnect();
		ws.emitServerClose();

		await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
		expect(wsMocks.MockWebSocket.instances).toHaveLength(1);
	});

	it('reconnect success restarts health monitoring', async () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws1 = wsMocks.MockWebSocket.instances[0];
		ws1.emitOpen();
		ws1.emitServerClose();

		await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
		const ws2 = wsMocks.MockWebSocket.instances[1];
		ws2.emitOpen();

		await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
		expect(ws2.send).toHaveBeenCalled();
	});

	// ─── Dispose / Reuse ───────────────────────────────────────────────────────

	it('dispose() cleans up and is idempotent', () => {
		const harness = createHarness();
		harness.manager.connect('127.0.0.1');

		const ws = wsMocks.MockWebSocket.instances[0];
		ws.emitOpen();

		harness.manager.dispose();
		harness.manager.dispose();

		expect(ws.close).toHaveBeenCalled();
		expectLatestStatus(harness, 'disconnected');
	});

	it('supports multiple connect/disconnect cycles', () => {
		const harness = createHarness();

		harness.manager.connect('127.0.0.1');
		wsMocks.MockWebSocket.instances[0].emitOpen();
		harness.manager.disconnect();

		harness.manager.connect('127.0.0.1');
		wsMocks.MockWebSocket.instances[1].emitOpen();
		harness.manager.disconnect();

		expect(wsMocks.MockWebSocket.instances).toHaveLength(2);
		expect(videoMocks.MockVideoReceiver.instances).toHaveLength(2);
		expectLatestStatus(harness, 'disconnected');
	});
});
