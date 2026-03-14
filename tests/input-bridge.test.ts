import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputBridge, type SocketFactory } from '../src/server/input-bridge.js';
import {
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	INPUT_SOCKET_PATH,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BACKOFF_MULTIPLIER,
	RECONNECT_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
} from '../src/shared/constants.js';
import type { InputEventData } from '../src/shared/protocol.js';

// ─── Mock Socket ─────────────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
	write = vi.fn((_data: string) => true);
	destroy = vi.fn(() => {
		this.emit('close');
	});
}

function createMockFactory(mockSocket: MockSocket): SocketFactory {
	return (() => mockSocket) as unknown as SocketFactory;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('InputBridge', () => {
	let mockSocket: MockSocket;
	let bridge: InputBridge;

	beforeEach(() => {
		vi.useFakeTimers();
		mockSocket = new MockSocket();
		bridge = new InputBridge(
			{ socketPath: '/tmp/test.sock', screenWidth: 1920, screenHeight: 1080 },
			createMockFactory(mockSocket),
		);
	});

	afterEach(() => {
		bridge.disconnect();
		vi.useRealTimers();
	});

	// ─── Default Config ──────────────────────────────────────────────────

	describe('default config', () => {
		it('uses defaults from constants', () => {
			const defaultBridge = new InputBridge(undefined, createMockFactory(mockSocket));
			const config = defaultBridge.getConfig();
			expect(config.socketPath).toBe(INPUT_SOCKET_PATH);
			expect(config.screenWidth).toBe(DEFAULT_WIDTH);
			expect(config.screenHeight).toBe(DEFAULT_HEIGHT);
			defaultBridge.disconnect();
		});

		it('allows partial config override', () => {
			const config = bridge.getConfig();
			expect(config.socketPath).toBe('/tmp/test.sock');
			expect(config.screenWidth).toBe(1920);
			expect(config.screenHeight).toBe(1080);
		});
	});

	// ─── Connection Lifecycle ────────────────────────────────────────────

	describe('connection lifecycle', () => {
		it('transitions to connecting then connected', () => {
			const states: string[] = [];
			bridge.on('stateChange', (s: string) => states.push(s));

			bridge.connect();
			expect(bridge.getState()).toBe('connecting');

			mockSocket.emit('connect');
			expect(bridge.getState()).toBe('connected');
			expect(states).toEqual(['connecting', 'connected']);
		});

		it('emits connected event', () => {
			const handler = vi.fn();
			bridge.on('connected', handler);

			bridge.connect();
			mockSocket.emit('connect');

			expect(handler).toHaveBeenCalledOnce();
		});

		it('no-ops if already connected', () => {
			bridge.connect();
			mockSocket.emit('connect');

			const factoryCalls = vi.fn();
			const bridge2 = new InputBridge({ socketPath: '/tmp/test.sock' }, ((...args: unknown[]) => {
				factoryCalls(...args);
				return mockSocket;
			}) as unknown as SocketFactory);
			bridge2.connect();
			(bridge2 as unknown as { socket: MockSocket }).socket?.emit('connect');
			bridge2.connect(); // Should no-op
			expect(factoryCalls).toHaveBeenCalledOnce();
			bridge2.disconnect();
		});

		it('no-ops if connecting', () => {
			const factoryCalls = vi.fn();
			const b = new InputBridge({ socketPath: '/tmp/test.sock' }, ((...args: unknown[]) => {
				factoryCalls(...args);
				return mockSocket;
			}) as unknown as SocketFactory);
			b.connect();
			b.connect(); // Should no-op
			expect(factoryCalls).toHaveBeenCalledOnce();
			b.disconnect();
		});

		it('disconnect destroys socket and transitions to disconnected', () => {
			bridge.connect();
			mockSocket.emit('connect');

			bridge.disconnect();
			expect(mockSocket.destroy).toHaveBeenCalled();
			expect(bridge.getState()).toBe('disconnected');
		});

		it('emits disconnected on socket close', () => {
			const handler = vi.fn();
			bridge.on('disconnected', handler);

			bridge.connect();
			mockSocket.emit('connect');

			// Simulate close without going through destroy (server-side close)
			const closeSocket = new MockSocket();
			closeSocket.destroy = vi.fn(); // Don't auto-emit close
			const b2 = new InputBridge({ socketPath: '/tmp/test.sock' }, createMockFactory(closeSocket));
			b2.on('disconnected', handler);
			b2.connect();
			closeSocket.emit('connect');
			closeSocket.emit('close');

			expect(handler).toHaveBeenCalled();
			b2.disconnect();
		});

		it('forwards socket errors', () => {
			const handler = vi.fn();
			bridge.on('error', handler);

			bridge.connect();
			const err = new Error('connection refused');
			mockSocket.emit('error', err);

			expect(handler).toHaveBeenCalledWith(err);
		});
	});

	// ─── Event Forwarding ────────────────────────────────────────────────

	describe('sendEvent', () => {
		it('returns false when not connected', () => {
			const event: InputEventData = {
				kind: 'key',
				key: 'a',
				modifiers: 0,
				down: true,
			};
			expect(bridge.sendEvent(event)).toBe(false);
		});

		it('writes JSON line for key events (no coordinate normalization)', () => {
			bridge.connect();
			mockSocket.emit('connect');

			const event: InputEventData = {
				kind: 'key',
				key: 'Enter',
				modifiers: 2,
				down: true,
			};
			const result = bridge.sendEvent(event);

			expect(result).toBe(true);
			expect(mockSocket.write).toHaveBeenCalledOnce();
			const written = mockSocket.write.mock.calls[0][0] as string;
			expect(written.endsWith('\n')).toBe(true);
			expect(JSON.parse(written)).toEqual(event);
		});

		it('normalizes mouse_move coordinates to pixels', () => {
			bridge.connect();
			mockSocket.emit('connect');

			const event: InputEventData = { kind: 'mouse_move', x: 0.5, y: 0.25 };
			bridge.sendEvent(event);

			const written = JSON.parse(mockSocket.write.mock.calls[0][0] as string);
			expect(written.x).toBe(960); // 0.5 * 1920
			expect(written.y).toBe(270); // 0.25 * 1080
		});

		it('normalizes mouse_click coordinates to pixels', () => {
			bridge.connect();
			mockSocket.emit('connect');

			const event: InputEventData = {
				kind: 'mouse_click',
				button: 'left',
				x: 1.0,
				y: 1.0,
				down: true,
			};
			bridge.sendEvent(event);

			const written = JSON.parse(mockSocket.write.mock.calls[0][0] as string);
			expect(written.x).toBe(1920);
			expect(written.y).toBe(1080);
			expect(written.button).toBe('left');
			expect(written.down).toBe(true);
		});

		it('normalizes scroll coordinates to pixels', () => {
			bridge.connect();
			mockSocket.emit('connect');

			const event: InputEventData = {
				kind: 'scroll',
				deltaX: 0,
				deltaY: -3,
				x: 0.75,
				y: 0.5,
			};
			bridge.sendEvent(event);

			const written = JSON.parse(mockSocket.write.mock.calls[0][0] as string);
			expect(written.x).toBe(1440); // 0.75 * 1920
			expect(written.y).toBe(540); // 0.5 * 1080
			expect(written.deltaX).toBe(0);
			expect(written.deltaY).toBe(-3);
		});

		it('rounds fractional pixel coordinates', () => {
			bridge.connect();
			mockSocket.emit('connect');

			const event: InputEventData = { kind: 'mouse_move', x: 0.333, y: 0.666 };
			bridge.sendEvent(event);

			const written = JSON.parse(mockSocket.write.mock.calls[0][0] as string);
			expect(written.x).toBe(Math.round(0.333 * 1920));
			expect(written.y).toBe(Math.round(0.666 * 1080));
		});
	});

	// ─── Coordinate Normalization ────────────────────────────────────────

	describe('normalizeCoordinates', () => {
		it('preserves key events unchanged', () => {
			const event: InputEventData = {
				kind: 'key',
				key: 'a',
				modifiers: 0,
				down: true,
			};
			expect(bridge.normalizeCoordinates(event)).toEqual(event);
		});

		it('converts origin (0,0) to pixel (0,0)', () => {
			const event: InputEventData = { kind: 'mouse_move', x: 0, y: 0 };
			const result = bridge.normalizeCoordinates(event);
			expect(result).toEqual({ kind: 'mouse_move', x: 0, y: 0 });
		});
	});

	// ─── Screen Size Update ──────────────────────────────────────────────

	describe('updateScreenSize', () => {
		it('uses updated dimensions for normalization', () => {
			bridge.updateScreenSize(3840, 2160);
			bridge.connect();
			mockSocket.emit('connect');

			const event: InputEventData = { kind: 'mouse_move', x: 0.5, y: 0.5 };
			bridge.sendEvent(event);

			const written = JSON.parse(mockSocket.write.mock.calls[0][0] as string);
			expect(written.x).toBe(1920); // 0.5 * 3840
			expect(written.y).toBe(1080); // 0.5 * 2160
		});
	});

	// ─── Reconnection ────────────────────────────────────────────────────

	describe('reconnection', () => {
		it('schedules reconnect on unexpected disconnect', () => {
			const reconnectHandler = vi.fn();
			bridge.on('reconnect', reconnectHandler);

			bridge.connect();
			mockSocket.emit('connect');

			// Simulate unexpected close
			const closeSocket = new MockSocket();
			closeSocket.destroy = vi.fn();
			const newFactory = createMockFactory(closeSocket);
			const b = new InputBridge({ socketPath: '/tmp/test.sock' }, newFactory);
			b.on('reconnect', reconnectHandler);
			b.connect();
			closeSocket.emit('connect');
			closeSocket.emit('close');

			expect(reconnectHandler).toHaveBeenCalledWith({
				attempt: 1,
				delay: RECONNECT_DELAY_MS,
			});
			b.disconnect();
		});

		it('does not reconnect after disconnect()', () => {
			const reconnectHandler = vi.fn();
			bridge.on('reconnect', reconnectHandler);

			bridge.connect();
			mockSocket.emit('connect');
			bridge.disconnect();

			expect(reconnectHandler).not.toHaveBeenCalled();
		});

		it('uses exponential backoff', () => {
			const reconnects: Array<{ attempt: number; delay: number }> = [];

			// Sockets that fail (close without connecting) to accumulate backoff
			const sockets: MockSocket[] = [];
			const factory: SocketFactory = (() => {
				const s = new MockSocket();
				s.destroy = vi.fn();
				sockets.push(s);
				return s;
			}) as unknown as SocketFactory;

			const b = new InputBridge({ socketPath: '/tmp/test.sock' }, factory);
			b.on('reconnect', (info: { attempt: number; delay: number }) => {
				reconnects.push(info);
			});

			// First connection fails (close without 'connect' — no reconnectCount reset)
			b.connect();
			sockets[0].emit('close');

			// First reconnect at base delay
			expect(reconnects[0]).toEqual({ attempt: 1, delay: RECONNECT_DELAY_MS });

			// Advance timer to trigger reconnect
			vi.advanceTimersByTime(RECONNECT_DELAY_MS);

			// Second socket also fails
			sockets[1].emit('close');

			// Second reconnect at backoff delay
			expect(reconnects[1]).toEqual({
				attempt: 2,
				delay: RECONNECT_DELAY_MS * RECONNECT_BACKOFF_MULTIPLIER,
			});

			b.disconnect();
		});

		it('caps delay at RECONNECT_MAX_DELAY_MS', () => {
			const reconnects: Array<{ attempt: number; delay: number }> = [];

			const sockets: MockSocket[] = [];
			const factory: SocketFactory = (() => {
				const s = new MockSocket();
				s.destroy = vi.fn();
				sockets.push(s);
				return s;
			}) as unknown as SocketFactory;

			const b = new InputBridge({ socketPath: '/tmp/test.sock' }, factory);
			b.on('reconnect', (info: { attempt: number; delay: number }) => {
				reconnects.push(info);
			});

			// Simulate many failed connections (no 'connect' event) to reach the cap
			b.connect();
			for (let i = 0; i < MAX_RECONNECT_ATTEMPTS - 1; i++) {
				sockets[i].emit('close');
				vi.advanceTimersByTime(RECONNECT_MAX_DELAY_MS + 1000);
			}

			// All delays should be <= MAX
			for (const r of reconnects) {
				expect(r.delay).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
			}

			b.disconnect();
		});

		it('emits error at max attempts', () => {
			const errorHandler = vi.fn();

			const sockets: MockSocket[] = [];
			const factory: SocketFactory = (() => {
				const s = new MockSocket();
				s.destroy = vi.fn();
				sockets.push(s);
				return s;
			}) as unknown as SocketFactory;

			const b = new InputBridge({ socketPath: '/tmp/test.sock' }, factory);
			b.on('error', errorHandler);

			b.connect();
			// Exhaust all reconnect attempts (fail without connecting)
			for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
				sockets[i].emit('close');
				vi.advanceTimersByTime(RECONNECT_MAX_DELAY_MS + 1000);
			}

			// After MAX attempts, next close hits the limit
			sockets[MAX_RECONNECT_ATTEMPTS].emit('close');

			expect(errorHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('Max reconnect attempts'),
				}),
			);
			expect(b.getState()).toBe('error');

			b.disconnect();
		});

		it('resets reconnect count on successful connection', () => {
			const reconnects: Array<{ attempt: number; delay: number }> = [];

			const sockets: MockSocket[] = [];
			const factory: SocketFactory = (() => {
				const s = new MockSocket();
				s.destroy = vi.fn();
				sockets.push(s);
				return s;
			}) as unknown as SocketFactory;

			const b = new InputBridge({ socketPath: '/tmp/test.sock' }, factory);
			b.on('reconnect', (info: { attempt: number; delay: number }) => {
				reconnects.push(info);
			});

			// Connect, disconnect, reconnect
			b.connect();
			sockets[0].emit('connect');
			sockets[0].emit('close');
			expect(reconnects[0].attempt).toBe(1);

			vi.advanceTimersByTime(RECONNECT_DELAY_MS);
			// Reconnected socket connects successfully — resets count
			sockets[1].emit('connect');
			sockets[1].emit('close');

			// After reset, attempt should be 1 again (not 2)
			expect(reconnects[1].attempt).toBe(1);

			b.disconnect();
		});
	});
});
