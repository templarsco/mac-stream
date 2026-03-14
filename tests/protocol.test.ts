import { describe, expect, it } from 'vitest';
import {
	CLIPBOARD_POLL_MS,
	DEFAULT_BITRATE,
	DEFAULT_CRF,
	DEFAULT_FPS,
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	HEALTH_INTERVAL_MS,
	HEALTH_TIMEOUT_MS,
	INPUT_AGENT_MAX_RESTARTS,
	INPUT_AGENT_RESTART_DELAY_MS,
	INPUT_SOCKET_PATH,
	MAX_RECONNECT_ATTEMPTS,
	MEMORY_CHECK_INTERVAL_MS,
	MEMORY_THRESHOLD_MB,
	MODIFIER_ALT,
	MODIFIER_CTRL,
	MODIFIER_META,
	MODIFIER_SHIFT,
	RECONNECT_BACKOFF_MULTIPLIER,
	RECONNECT_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
	VIDEO_PORT,
	WS_PORT,
} from '../src/shared/constants.js';
import {
	type ClipboardUpdateMessage,
	type ErrorMessage,
	type HealthPingMessage,
	type InputEventMessage,
	type KeyframeRequestMessage,
	type ProtocolMessage,
	type SessionStartMessage,
	type StreamConfigMessage,
	type StreamControlMessage,
	createMessage,
	parseMessage,
	serializeMessage,
} from '../src/shared/protocol.js';

// ─── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
	it('has correct network ports', () => {
		expect(WS_PORT).toBe(8765);
		expect(VIDEO_PORT).toBe(5004);
	});

	it('has correct video defaults', () => {
		expect(DEFAULT_FPS).toBe(60);
		expect(DEFAULT_WIDTH).toBe(1920);
		expect(DEFAULT_HEIGHT).toBe(1080);
		expect(DEFAULT_BITRATE).toBe(6_000);
		expect(DEFAULT_CRF).toBe(23);
	});

	it('has correct timing defaults', () => {
		expect(CLIPBOARD_POLL_MS).toBe(100);
		expect(HEALTH_INTERVAL_MS).toBe(5_000);
		expect(HEALTH_TIMEOUT_MS).toBe(15_000);
	});

	it('has correct reconnection defaults', () => {
		expect(MAX_RECONNECT_ATTEMPTS).toBe(10);
		expect(RECONNECT_DELAY_MS).toBe(1_000);
		expect(RECONNECT_BACKOFF_MULTIPLIER).toBe(1.5);
		expect(RECONNECT_MAX_DELAY_MS).toBe(30_000);
	});

	it('has correct modifier bitmasks', () => {
		expect(MODIFIER_SHIFT).toBe(1);
		expect(MODIFIER_CTRL).toBe(2);
		expect(MODIFIER_ALT).toBe(4);
		expect(MODIFIER_META).toBe(8);
	});

	it('has input socket path', () => {
		expect(INPUT_SOCKET_PATH).toBe('/tmp/macstream-input.sock');
	});

	it('has recovery defaults', () => {
		expect(MEMORY_THRESHOLD_MB).toBe(500);
		expect(MEMORY_CHECK_INTERVAL_MS).toBe(30_000);
		expect(INPUT_AGENT_MAX_RESTARTS).toBe(5);
		expect(INPUT_AGENT_RESTART_DELAY_MS).toBe(2_000);
	});
});

// ─── createMessage ───────────────────────────────────────────────────────────

describe('createMessage', () => {
	it('creates a clipboard_update message with auto timestamp', () => {
		const before = Date.now();
		const msg = createMessage<ClipboardUpdateMessage>('clipboard_update', {
			content: 'hello',
			format: 'text',
		});
		const after = Date.now();

		expect(msg.type).toBe('clipboard_update');
		expect(msg.content).toBe('hello');
		expect(msg.format).toBe('text');
		expect(msg.timestamp).toBeGreaterThanOrEqual(before);
		expect(msg.timestamp).toBeLessThanOrEqual(after);
	});

	it('allows overriding timestamp', () => {
		const msg = createMessage<HealthPingMessage>('health_ping', {
			timestamp: 42,
		});

		expect(msg.type).toBe('health_ping');
		expect(msg.timestamp).toBe(42);
	});

	it('creates input_event with keyboard data', () => {
		const msg = createMessage<InputEventMessage>('input_event', {
			event: {
				kind: 'key',
				key: 'a',
				modifiers: MODIFIER_CTRL | MODIFIER_SHIFT,
				down: true,
			},
		});

		expect(msg.type).toBe('input_event');
		expect(msg.event.kind).toBe('key');
		if (msg.event.kind === 'key') {
			expect(msg.event.key).toBe('a');
			expect(msg.event.modifiers).toBe(3); // CTRL | SHIFT
			expect(msg.event.down).toBe(true);
		}
	});

	it('creates input_event with mouse_move data', () => {
		const msg = createMessage<InputEventMessage>('input_event', {
			event: { kind: 'mouse_move', x: 0.5, y: 0.75 },
		});

		expect(msg.event.kind).toBe('mouse_move');
		if (msg.event.kind === 'mouse_move') {
			expect(msg.event.x).toBe(0.5);
			expect(msg.event.y).toBe(0.75);
		}
	});

	it('creates input_event with mouse_click data', () => {
		const msg = createMessage<InputEventMessage>('input_event', {
			event: { kind: 'mouse_click', button: 'right', x: 0.1, y: 0.2, down: true },
		});

		expect(msg.event.kind).toBe('mouse_click');
		if (msg.event.kind === 'mouse_click') {
			expect(msg.event.button).toBe('right');
			expect(msg.event.down).toBe(true);
		}
	});

	it('creates input_event with scroll data', () => {
		const msg = createMessage<InputEventMessage>('input_event', {
			event: { kind: 'scroll', deltaX: 0, deltaY: -120, x: 0.5, y: 0.5 },
		});

		expect(msg.event.kind).toBe('scroll');
		if (msg.event.kind === 'scroll') {
			expect(msg.event.deltaY).toBe(-120);
		}
	});

	it('creates session_start with capabilities', () => {
		const msg = createMessage<SessionStartMessage>('session_start', {
			clientId: 'win-client-1',
			capabilities: ['clipboard', 'input', 'audio'],
		});

		expect(msg.type).toBe('session_start');
		expect(msg.clientId).toBe('win-client-1');
		expect(msg.capabilities).toEqual(['clipboard', 'input', 'audio']);
	});

	it('creates stream_config with video parameters', () => {
		const msg = createMessage<StreamConfigMessage>('stream_config', {
			width: DEFAULT_WIDTH,
			height: DEFAULT_HEIGHT,
			fps: DEFAULT_FPS,
			bitrate: DEFAULT_BITRATE,
			codec: 'h264',
		});

		expect(msg.width).toBe(1920);
		expect(msg.height).toBe(1080);
		expect(msg.fps).toBe(60);
		expect(msg.bitrate).toBe(6_000);
		expect(msg.codec).toBe('h264');
	});

	it('creates stream_control with action', () => {
		const msg = createMessage<StreamControlMessage>('stream_control', {
			action: 'restart',
		});

		expect(msg.type).toBe('stream_control');
		expect(msg.action).toBe('restart');
	});

	it('creates keyframe_request message', () => {
		const msg = createMessage<KeyframeRequestMessage>('keyframe_request', {});

		expect(msg.type).toBe('keyframe_request');
		expect(typeof msg.timestamp).toBe('number');
	});

	it('creates error message with code and message', () => {
		const msg = createMessage<ErrorMessage>('error', {
			code: 'FFMPEG_CRASH',
			message: 'FFmpeg process exited with code 1',
		});

		expect(msg.type).toBe('error');
		expect(msg.code).toBe('FFMPEG_CRASH');
		expect(msg.message).toBe('FFmpeg process exited with code 1');
	});
});

// ─── parseMessage ────────────────────────────────────────────────────────────

describe('parseMessage', () => {
	it('parses a valid clipboard_update message', () => {
		const raw = JSON.stringify({
			type: 'clipboard_update',
			timestamp: 1000,
			content: 'copied text',
			format: 'text',
		});

		const msg = parseMessage(raw);
		expect(msg.type).toBe('clipboard_update');
		if (msg.type === 'clipboard_update') {
			expect(msg.content).toBe('copied text');
			expect(msg.format).toBe('text');
		}
	});

	it('parses a valid health_ping message', () => {
		const msg = parseMessage('{"type":"health_ping","timestamp":999}');
		expect(msg.type).toBe('health_ping');
		expect(msg.timestamp).toBe(999);
	});

	it('parses a valid keyframe_request message', () => {
		const msg = parseMessage('{"type":"keyframe_request","timestamp":999}');
		expect(msg.type).toBe('keyframe_request');
		expect(msg.timestamp).toBe(999);
	});

	it('throws on invalid JSON', () => {
		expect(() => parseMessage('not json')).toThrow('Invalid JSON');
	});

	it('throws when message is not an object', () => {
		expect(() => parseMessage('"string"')).toThrow('Message must be an object');
		expect(() => parseMessage('42')).toThrow('Message must be an object');
		expect(() => parseMessage('null')).toThrow('Message must be an object');
	});

	it('throws when type field is missing', () => {
		expect(() => parseMessage('{"timestamp":1}')).toThrow('string "type" field');
	});

	it('throws when type field is not a string', () => {
		expect(() => parseMessage('{"type":42,"timestamp":1}')).toThrow('string "type" field');
	});

	it('throws on unknown message type', () => {
		expect(() => parseMessage('{"type":"bogus","timestamp":1}')).toThrow(
			'Unknown message type: bogus',
		);
	});

	it('throws when timestamp is missing', () => {
		expect(() => parseMessage('{"type":"health_ping"}')).toThrow('numeric "timestamp" field');
	});

	it('throws when timestamp is not a number', () => {
		expect(() => parseMessage('{"type":"health_ping","timestamp":"now"}')).toThrow(
			'numeric "timestamp" field',
		);
	});
});

// ─── serializeMessage ────────────────────────────────────────────────────────

describe('serializeMessage', () => {
	it('serializes a message to JSON', () => {
		const msg = createMessage<HealthPingMessage>('health_ping', {
			timestamp: 500,
		});
		const json = serializeMessage(msg);
		expect(json).toBe('{"type":"health_ping","timestamp":500}');
	});

	it('round-trips through serialize → parse', () => {
		const original = createMessage<ClipboardUpdateMessage>('clipboard_update', {
			content: 'test content',
			format: 'html',
			timestamp: 12345,
		});

		const roundTripped = parseMessage(serializeMessage(original));

		expect(roundTripped.type).toBe(original.type);
		expect(roundTripped.timestamp).toBe(original.timestamp);
		if (roundTripped.type === 'clipboard_update') {
			expect(roundTripped.content).toBe(original.content);
			expect(roundTripped.format).toBe(original.format);
		}
	});

	it('round-trips input_event with keyboard data', () => {
		const original = createMessage<InputEventMessage>('input_event', {
			event: { kind: 'key', key: 'Enter', modifiers: 0, down: true },
			timestamp: 777,
		});

		const roundTripped = parseMessage(serializeMessage(original));
		expect(roundTripped.type).toBe('input_event');
		if (roundTripped.type === 'input_event') {
			expect(roundTripped.event).toEqual(original.event);
		}
	});

	it('round-trips session_start', () => {
		const original = createMessage<SessionStartMessage>('session_start', {
			clientId: 'abc-123',
			capabilities: ['clipboard'],
			timestamp: 888,
		});

		const roundTripped = parseMessage(serializeMessage(original));
		expect(roundTripped.type).toBe('session_start');
		if (roundTripped.type === 'session_start') {
			expect(roundTripped.clientId).toBe('abc-123');
			expect(roundTripped.capabilities).toEqual(['clipboard']);
		}
	});
});

// ─── Discriminated Union Narrowing ───────────────────────────────────────────

describe('discriminated union narrowing', () => {
	it('narrows clipboard_update correctly', () => {
		const msg: ProtocolMessage = createMessage<ClipboardUpdateMessage>('clipboard_update', {
			content: 'narrow me',
			format: 'text',
		});

		if (msg.type === 'clipboard_update') {
			// TypeScript should narrow to ClipboardUpdateMessage here
			const _content: string = msg.content;
			const _format: 'text' | 'html' | 'image' = msg.format;
			expect(_content).toBe('narrow me');
			expect(_format).toBe('text');
		} else {
			// Should not reach here
			expect.unreachable('Expected clipboard_update type');
		}
	});

	it('narrows input_event and then nested kind', () => {
		const msg: ProtocolMessage = createMessage<InputEventMessage>('input_event', {
			event: { kind: 'mouse_click', button: 'left', x: 0.3, y: 0.7, down: false },
		});

		if (msg.type === 'input_event') {
			const evt = msg.event;
			if (evt.kind === 'mouse_click') {
				const _button: 'left' | 'right' | 'middle' = evt.button;
				expect(_button).toBe('left');
				expect(evt.down).toBe(false);
			} else {
				expect.unreachable('Expected mouse_click kind');
			}
		} else {
			expect.unreachable('Expected input_event type');
		}
	});

	it('narrows error message fields', () => {
		const msg: ProtocolMessage = createMessage<ErrorMessage>('error', {
			code: 'TEST',
			message: 'test error',
		});

		if (msg.type === 'error') {
			const _code: string = msg.code;
			const _message: string = msg.message;
			expect(_code).toBe('TEST');
			expect(_message).toBe('test error');
		} else {
			expect.unreachable('Expected error type');
		}
	});
});
