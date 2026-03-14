// ─── Message Types ───────────────────────────────────────────────────────────

export type MessageType =
	| 'clipboard_update'
	| 'clipboard_request'
	| 'input_event'
	| 'keyframe_request'
	| 'session_start'
	| 'session_end'
	| 'health_ping'
	| 'health_pong'
	| 'stream_config'
	| 'stream_control'
	| 'error';

// ─── Input Events ────────────────────────────────────────────────────────────

export interface KeyboardInputEvent {
	kind: 'key';
	key: string;
	modifiers: number; // Bitmask: Shift=1, Ctrl=2, Alt=4, Meta=8
	down: boolean;
}

export interface MouseMoveInputEvent {
	kind: 'mouse_move';
	x: number; // Normalized 0.0–1.0
	y: number;
}

export interface MouseClickInputEvent {
	kind: 'mouse_click';
	button: 'left' | 'right' | 'middle';
	x: number;
	y: number;
	down: boolean;
}

export interface ScrollInputEvent {
	kind: 'scroll';
	deltaX: number;
	deltaY: number;
	x: number;
	y: number;
}

export type InputEventData =
	| KeyboardInputEvent
	| MouseMoveInputEvent
	| MouseClickInputEvent
	| ScrollInputEvent;

// ─── Messages (discriminated union on `type`) ────────────────────────────────

export interface ClipboardUpdateMessage {
	type: 'clipboard_update';
	timestamp: number;
	content: string;
	format: 'text' | 'html' | 'image';
}

export interface ClipboardRequestMessage {
	type: 'clipboard_request';
	timestamp: number;
}

export interface InputEventMessage {
	type: 'input_event';
	timestamp: number;
	event: InputEventData;
}

export interface KeyframeRequestMessage {
	type: 'keyframe_request';
	timestamp: number;
}

export interface SessionStartMessage {
	type: 'session_start';
	timestamp: number;
	clientId: string;
	capabilities: string[];
}

export interface SessionEndMessage {
	type: 'session_end';
	timestamp: number;
	reason: string;
}

export interface HealthPingMessage {
	type: 'health_ping';
	timestamp: number;
}

export interface HealthPongMessage {
	type: 'health_pong';
	timestamp: number;
}

export interface StreamConfigMessage {
	type: 'stream_config';
	timestamp: number;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	codec: string;
}

export interface StreamControlMessage {
	type: 'stream_control';
	timestamp: number;
	action: 'start' | 'stop' | 'restart';
}

export interface ErrorMessage {
	type: 'error';
	timestamp: number;
	code: string;
	message: string;
}

export type ProtocolMessage =
	| ClipboardUpdateMessage
	| ClipboardRequestMessage
	| InputEventMessage
	| KeyframeRequestMessage
	| SessionStartMessage
	| SessionEndMessage
	| HealthPingMessage
	| HealthPongMessage
	| StreamConfigMessage
	| StreamControlMessage
	| ErrorMessage;

// ─── Utilities ───────────────────────────────────────────────────────────────

const VALID_MESSAGE_TYPES = new Set<MessageType>([
	'clipboard_update',
	'clipboard_request',
	'input_event',
	'keyframe_request',
	'session_start',
	'session_end',
	'health_ping',
	'health_pong',
	'stream_config',
	'stream_control',
	'error',
]);

/**
 * Creates a typed protocol message with auto-populated timestamp.
 *
 * The `type` and `timestamp` fields are handled by providing `type` explicitly
 * and `timestamp` as an optional override (defaults to `Date.now()`).
 */
export function createMessage<T extends ProtocolMessage>(
	type: T['type'],
	fields: Omit<T, 'type' | 'timestamp'> & { timestamp?: number },
): T {
	return {
		type,
		timestamp: fields.timestamp ?? Date.now(),
		...fields,
	} as T;
}

/**
 * Parses a raw JSON string into a validated `ProtocolMessage`.
 * Throws on invalid JSON or unrecognized message type.
 */
export function parseMessage(raw: string): ProtocolMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('Invalid JSON');
	}

	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('Message must be an object');
	}

	const obj = parsed as Record<string, unknown>;

	if (typeof obj.type !== 'string') {
		throw new Error('Message must have a string "type" field');
	}

	if (!VALID_MESSAGE_TYPES.has(obj.type as MessageType)) {
		throw new Error(`Unknown message type: ${obj.type}`);
	}

	if (typeof obj.timestamp !== 'number') {
		throw new Error('Message must have a numeric "timestamp" field');
	}

	return obj as unknown as ProtocolMessage;
}

/**
 * Serializes a `ProtocolMessage` to a JSON string.
 */
export function serializeMessage(msg: ProtocolMessage): string {
	return JSON.stringify(msg);
}
