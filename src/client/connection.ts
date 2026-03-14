import WebSocket, { type RawData } from 'ws';
import {
	HEALTH_INTERVAL_MS,
	HEALTH_TIMEOUT_MS,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BACKOFF_MULTIPLIER,
	RECONNECT_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
	VIDEO_PORT,
	WS_PORT,
} from '../shared/constants.js';
import {
	type ProtocolMessage,
	createMessage,
	parseMessage,
	serializeMessage,
} from '../shared/protocol.js';
import type { ConnectionStatus } from './types.js';
import { VideoReceiver } from './video-receiver.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConnectionManagerOptions {
	onStatus: (status: ConnectionStatus) => void;
	onVideoFrame: (data: Buffer, pts: number, isKeyframe: boolean) => void;
	onVideoConfig: (config: {
		codec: string;
		width: number;
		height: number;
	}) => void;
	onMessage: (message: ProtocolMessage) => void;
}

// ─── Connection Manager ──────────────────────────────────────────────────────

export class ConnectionManager {
	private readonly options: ConnectionManagerOptions;
	private status: ConnectionStatus = 'disconnected';
	private wsClient: WebSocket | null = null;
	private videoReceiver: VideoReceiver | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private lastPongTimestamp = 0;
	private shouldReconnect = false;
	private isDisposed = false;
	private hasStreamingStarted = false;

	private serverIp: string | null = null;
	private wsPort = WS_PORT;
	private videoPort = VIDEO_PORT;

	constructor(options: ConnectionManagerOptions) {
		this.options = options;
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	connect(serverIp: string, wsPort?: number, videoPort?: number): void {
		if (this.isDisposed) {
			return;
		}

		this.serverIp = serverIp;
		this.wsPort = wsPort ?? WS_PORT;
		this.videoPort = videoPort ?? VIDEO_PORT;
		this.hasStreamingStarted = false;
		this.shouldReconnect = true;

		this.setStatus('connecting');
		this.openWebSocket();
	}

	disconnect(): void {
		this.shouldReconnect = false;
		this.reconnectAttempts = 0;
		this.clearReconnectTimer();
		this.stopHealthMonitoring();

		if (this.videoReceiver) {
			this.videoReceiver.stop();
			this.videoReceiver.removeAllListeners();
			this.videoReceiver = null;
		}

		if (this.wsClient) {
			this.wsClient.removeAllListeners();
			this.wsClient.close();
			this.wsClient = null;
		}

		this.setStatus('disconnected');
	}

	sendMessage(message: ProtocolMessage): void {
		if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			return;
		}

		this.wsClient.send(serializeMessage(message));
	}

	dispose(): void {
		if (this.isDisposed) {
			return;
		}

		this.disconnect();
		this.serverIp = null;
		this.wsClient = null;
		this.videoReceiver = null;
		this.isDisposed = true;
	}

	// ─── WebSocket Lifecycle ────────────────────────────────────────────────

	private openWebSocket(): void {
		if (this.serverIp === null) {
			return;
		}

		if (this.wsClient) {
			this.wsClient.removeAllListeners();
			this.wsClient.close();
			this.wsClient = null;
		}

		const wsClient = new WebSocket(`ws://${this.serverIp}:${String(this.wsPort)}`);
		this.wsClient = wsClient;

		wsClient.on('open', () => {
			if (this.wsClient !== wsClient) {
				return;
			}

			this.reconnectAttempts = 0;
			this.setStatus('connected');
			this.ensureVideoReceiver();
			this.startHealthMonitoring();
		});

		wsClient.on('message', (rawData: RawData) => {
			this.handleIncomingMessage(rawData);
		});

		wsClient.on('close', () => {
			if (this.wsClient === wsClient) {
				this.wsClient = null;
			}

			this.stopHealthMonitoring();

			if (this.shouldReconnect && !this.isDisposed) {
				this.scheduleReconnect();
			}
		});

		wsClient.on('error', (error: Error) => {
			console.error('[MacStream] WebSocket error:', error);
			this.setStatus('error');
		});
	}

	private ensureVideoReceiver(): void {
		if (this.videoReceiver) {
			return;
		}

		const receiver = new VideoReceiver(this.videoPort);
		this.videoReceiver = receiver;

		receiver.on('config', (config: { codec: string; width: number; height: number }) => {
			this.options.onVideoConfig(config);
		});

		receiver.on('frame', (frame: { data: Buffer; pts: number; isKeyframe: boolean }) => {
			if (!this.hasStreamingStarted) {
				this.hasStreamingStarted = true;
				this.setStatus('streaming');
			}

			this.options.onVideoFrame(frame.data, frame.pts, frame.isKeyframe);
		});

		receiver.on('error', (error: Error) => {
			console.error('[MacStream] Video receiver error:', error);
			this.setStatus('error');
		});

		receiver.start();
	}

	// ─── Reconnection ───────────────────────────────────────────────────────

	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			console.error(
				`[MacStream] Max reconnect attempts (${String(MAX_RECONNECT_ATTEMPTS)}) reached`,
			);
			this.setStatus('error');
			return;
		}

		this.clearReconnectTimer();

		const delay = Math.min(
			RECONNECT_DELAY_MS * RECONNECT_BACKOFF_MULTIPLIER ** this.reconnectAttempts,
			RECONNECT_MAX_DELAY_MS,
		);
		this.reconnectAttempts += 1;

		this.setStatus('connecting');
		console.log(
			`[MacStream] Reconnecting in ${String(delay)}ms (attempt ${String(this.reconnectAttempts)})`,
		);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.openWebSocket();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	// ─── Health Monitoring ──────────────────────────────────────────────────

	private startHealthMonitoring(): void {
		this.stopHealthMonitoring();
		this.lastPongTimestamp = Date.now();

		this.healthTimer = setInterval(() => {
			const wsClient = this.wsClient;
			if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
				return;
			}

			const now = Date.now();
			if (now - this.lastPongTimestamp > HEALTH_TIMEOUT_MS) {
				console.error('[MacStream] Health timeout; treating connection as lost');
				wsClient.close();
				return;
			}

			const ping = createMessage('health_ping', {});
			wsClient.send(serializeMessage(ping));
		}, HEALTH_INTERVAL_MS);
	}

	private stopHealthMonitoring(): void {
		if (this.healthTimer !== null) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}
	}

	// ─── Message Handling ───────────────────────────────────────────────────

	private handleIncomingMessage(rawData: RawData): void {
		const rawMessage = this.rawDataToString(rawData);

		let message: ProtocolMessage;
		try {
			message = parseMessage(rawMessage);
		} catch (error) {
			console.error('[MacStream] Failed to parse WebSocket message:', error);
			return;
		}

		if (message.type === 'health_pong') {
			this.lastPongTimestamp = Date.now();
			return;
		}

		this.options.onMessage(message);
	}

	private rawDataToString(rawData: RawData): string {
		if (typeof rawData === 'string') {
			return rawData;
		}

		if (Array.isArray(rawData)) {
			return Buffer.concat(rawData).toString();
		}

		if (rawData instanceof ArrayBuffer) {
			return Buffer.from(rawData).toString();
		}

		if (ArrayBuffer.isView(rawData)) {
			return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString();
		}

		return String(rawData);
	}

	// ─── State ──────────────────────────────────────────────────────────────

	private setStatus(status: ConnectionStatus): void {
		if (this.status === status) {
			return;
		}

		this.status = status;
		this.options.onStatus(status);
	}
}
