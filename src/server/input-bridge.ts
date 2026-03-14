import { EventEmitter } from 'node:events';
import { type Socket, createConnection } from 'node:net';
import {
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	INPUT_SOCKET_PATH,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BACKOFF_MULTIPLIER,
	RECONNECT_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
} from '../shared/constants.js';
import type { InputEventData } from '../shared/protocol.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InputBridgeConfig {
	socketPath: string;
	screenWidth: number;
	screenHeight: number;
}

export type InputBridgeState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Factory function for creating socket connections.
 * Injected for testability — production uses `net.createConnection`.
 */
export type SocketFactory = (path: string) => Socket;

// ─── Input Bridge ────────────────────────────────────────────────────────────

/**
 * Bridges WebSocket input events to the Swift Input Agent via Unix domain socket.
 *
 * Responsibilities:
 * - Connects to the Swift agent's Unix domain socket
 * - Normalizes coordinates from 0.0–1.0 → screen pixels
 * - Serializes InputEventData as JSON lines (newline-delimited)
 * - Handles reconnection with exponential backoff on disconnect
 *
 * Events: 'connected', 'disconnected', 'error', 'reconnect', 'stateChange'
 */
export class InputBridge extends EventEmitter {
	private config: InputBridgeConfig;
	private socket: Socket | null = null;
	private state: InputBridgeState = 'disconnected';
	private reconnectCount = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private shouldReconnect = true;
	private readonly socketFactory: SocketFactory;

	constructor(config?: Partial<InputBridgeConfig>, socketFactory?: SocketFactory) {
		super();
		this.config = {
			socketPath: config?.socketPath ?? INPUT_SOCKET_PATH,
			screenWidth: config?.screenWidth ?? DEFAULT_WIDTH,
			screenHeight: config?.screenHeight ?? DEFAULT_HEIGHT,
		};
		this.socketFactory = socketFactory ?? createConnection;
	}

	// ─── Connection Lifecycle ──────────────────────────────────────────────

	/**
	 * Connects to the Swift Input Agent socket.
	 * No-op if already connected or connecting.
	 */
	connect(): void {
		if (this.state === 'connected' || this.state === 'connecting') {
			return;
		}

		this.setState('connecting');
		this.shouldReconnect = true;

		const socket = this.socketFactory(this.config.socketPath);
		this.socket = socket;

		socket.on('connect', () => {
			this.reconnectCount = 0;
			this.setState('connected');
			this.emit('connected');
		});

		socket.on('error', (err: Error) => {
			this.emit('error', err);
		});

		socket.on('close', () => {
			this.socket = null;
			this.setState('disconnected');
			this.emit('disconnected');

			if (this.shouldReconnect) {
				this.scheduleReconnect();
			}
		});
	}

	/**
	 * Disconnects from the Swift Input Agent socket.
	 * Cancels any pending reconnection attempts.
	 */
	disconnect(): void {
		this.shouldReconnect = false;

		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}

		this.setState('disconnected');
	}

	// ─── Event Forwarding ──────────────────────────────────────────────────

	/**
	 * Sends an input event to the Swift Input Agent.
	 * Normalizes coordinates (0.0–1.0 → pixels) and writes as JSON line.
	 *
	 * @returns `true` if the event was written, `false` if not connected.
	 */
	sendEvent(event: InputEventData): boolean {
		if (this.state !== 'connected' || !this.socket) {
			return false;
		}

		const normalized = this.normalizeCoordinates(event);
		const line = `${JSON.stringify(normalized)}\n`;

		return this.socket.write(line);
	}

	// ─── Coordinate Normalization ──────────────────────────────────────────

	/**
	 * Converts normalized 0.0–1.0 coordinates to screen pixel values.
	 * Key events pass through unchanged (no coordinates to normalize).
	 */
	normalizeCoordinates(event: InputEventData): InputEventData {
		const { screenWidth, screenHeight } = this.config;

		switch (event.kind) {
			case 'key':
				return event;
			case 'mouse_move':
				return {
					...event,
					x: Math.round(event.x * screenWidth),
					y: Math.round(event.y * screenHeight),
				};
			case 'mouse_click':
				return {
					...event,
					x: Math.round(event.x * screenWidth),
					y: Math.round(event.y * screenHeight),
				};
			case 'scroll':
				return {
					...event,
					x: Math.round(event.x * screenWidth),
					y: Math.round(event.y * screenHeight),
				};
		}
	}

	// ─── Reconnection ──────────────────────────────────────────────────────

	private scheduleReconnect(): void {
		if (this.reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
			this.setState('error');
			this.emit('error', new Error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`));
			return;
		}

		const delay = Math.min(
			RECONNECT_DELAY_MS * RECONNECT_BACKOFF_MULTIPLIER ** this.reconnectCount,
			RECONNECT_MAX_DELAY_MS,
		);

		this.reconnectCount++;
		this.emit('reconnect', { attempt: this.reconnectCount, delay });

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	// ─── State ─────────────────────────────────────────────────────────────

	private setState(newState: InputBridgeState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.emit('stateChange', newState);
		}
	}

	getState(): InputBridgeState {
		return this.state;
	}

	getConfig(): Readonly<InputBridgeConfig> {
		return { ...this.config };
	}

	/**
	 * Updates the screen dimensions used for coordinate normalization.
	 * Call this when the server receives a stream_config message with new dimensions.
	 */
	updateScreenSize(width: number, height: number): void {
		this.config.screenWidth = width;
		this.config.screenHeight = height;
	}
}
