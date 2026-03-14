import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket, { type RawData, WebSocketServer as WSServer } from 'ws';
import { HEALTH_INTERVAL_MS, HEALTH_TIMEOUT_MS, WS_PORT } from '../shared/constants.js';
import {
	type ErrorMessage,
	type ProtocolMessage,
	createMessage,
	parseMessage,
	serializeMessage,
} from '../shared/protocol.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type WebSocketServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

type WebSocketServerOptions = ConstructorParameters<typeof WSServer>[0];
type WSServerCtor = new (options: WebSocketServerOptions) => WSServer;
type WSServerFactory = (options: WebSocketServerOptions) => WSServer;
type WSServerProvider = WSServerCtor | WSServerFactory;

interface ServerConfig {
	port?: number;
}

// ─── MacStreamWebSocketServer ────────────────────────────────────────────────

export class MacStreamWebSocketServer extends EventEmitter {
	private readonly port: number;
	private readonly serverProvider: WSServerProvider;
	private server: WSServer | null = null;
	private currentState: WebSocketServerState = 'stopped';
	private readonly clients = new Map<string, WebSocket>();
	private readonly lastPingAt = new Map<string, number>();
	private healthTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: ServerConfig = {}, serverFactory?: WSServerProvider) {
		super();
		this.port = config.port ?? WS_PORT;
		this.serverProvider = serverFactory ?? WSServer;
	}

	// ─── Accessors ─────────────────────────────────────────────────────────────

	getState(): WebSocketServerState {
		return this.currentState;
	}

	getClients(): string[] {
		return [...this.clients.keys()];
	}

	getClientCount(): number {
		return this.clients.size;
	}

	getPort(): number | null {
		if (!this.server) {
			return null;
		}

		const address = this.server.address();
		if (!address || typeof address === 'string') {
			return null;
		}

		return address.port;
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.currentState === 'running' || this.currentState === 'starting') {
			return;
		}

		this.setState('starting');

		const server = this.createServer({ port: this.port });
		this.server = server;

		server.on('connection', (socket: WebSocket) => {
			this.handleConnection(socket);
		});

		server.on('error', (error: Error) => {
			if (this.currentState !== 'starting') {
				this.setState('error');
				this.emit('error', { clientId: null, error });
			}
		});

		return new Promise<void>((resolve, reject) => {
			const onListening = (): void => {
				server.off('error', onStartError);
				this.setState('running');
				this.startHealthCheck();
				resolve();
			};

			const onStartError = (error: Error): void => {
				server.off('listening', onListening);
				this.setState('error');
				reject(error);
			};

			server.once('listening', onListening);
			server.once('error', onStartError);
		});
	}

	async close(): Promise<void> {
		this.stopHealthCheck();

		if (this.currentState === 'stopped' && !this.server) {
			return;
		}

		this.setState('stopping');

		for (const socket of this.clients.values()) {
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close();
			}
		}

		this.clients.clear();
		this.lastPingAt.clear();

		const server = this.server;
		if (!server) {
			this.setState('stopped');
			return;
		}

		await new Promise<void>((resolve, reject) => {
			server.close((error?: Error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});

		this.server = null;
		this.setState('stopped');
	}

	send(clientId: string, message: ProtocolMessage): void {
		const socket = this.clients.get(clientId);
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return;
		}

		socket.send(serializeMessage(message));
	}

	broadcast(message: ProtocolMessage): void {
		for (const clientId of this.clients.keys()) {
			this.send(clientId, message);
		}
	}

	startHealthCheck(): void {
		this.stopHealthCheck();
		this.healthTimer = setInterval(() => {
			const now = Date.now();
			for (const [clientId, lastPing] of this.lastPingAt.entries()) {
				if (now - lastPing <= HEALTH_TIMEOUT_MS) {
					continue;
				}

				const socket = this.clients.get(clientId);
				if (!socket) {
					this.lastPingAt.delete(clientId);
					continue;
				}

				socket.terminate();
			}
		}, HEALTH_INTERVAL_MS);
	}

	// ─── Private ───────────────────────────────────────────────────────────────

	private createServer(options: WebSocketServerOptions): WSServer {
		try {
			return new (this.serverProvider as WSServerCtor)(options);
		} catch {
			return (this.serverProvider as WSServerFactory)(options);
		}
	}

	private setState(state: WebSocketServerState): void {
		if (this.currentState !== state) {
			this.currentState = state;
			this.emit('stateChange', state);
		}
	}

	private stopHealthCheck(): void {
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}
	}

	private handleConnection(socket: WebSocket): void {
		const clientId = randomUUID();
		this.clients.set(clientId, socket);
		this.lastPingAt.set(clientId, Date.now());
		this.emit('connection', clientId);

		socket.on('message', (rawData: RawData) => {
			this.handleMessage(clientId, rawData);
		});

		socket.on('close', () => {
			this.clients.delete(clientId);
			this.lastPingAt.delete(clientId);
			this.emit('disconnection', clientId);
		});

		socket.on('error', (error: Error) => {
			this.emit('error', { clientId, error });
		});
	}

	private handleMessage(clientId: string, rawData: RawData): void {
		const socket = this.clients.get(clientId);
		if (!socket) {
			return;
		}

		let message: ProtocolMessage;
		try {
			message = parseMessage(this.rawDataToString(rawData));
		} catch (error) {
			this.sendBadMessageError(socket, error);
			return;
		}

		switch (message.type) {
			case 'health_ping': {
				this.lastPingAt.set(clientId, Date.now());
				socket.send(serializeMessage(createMessage('health_pong', {})));
				break;
			}

			case 'keyframe_request': {
				this.emit('keyframe:request', clientId);
				break;
			}

			case 'session_start': {
				this.emit('session:start', { clientId, message });
				break;
			}

			case 'session_end': {
				this.emit('session:end', { clientId, message });
				socket.close();
				break;
			}

			case 'clipboard_update': {
				this.emit('clipboard:update', message);
				break;
			}

			case 'clipboard_request': {
				this.emit('clipboard:request', clientId);
				break;
			}

			case 'input_event': {
				this.emit('input', message);
				break;
			}

			case 'stream_config': {
				this.emit('stream:config', message);
				break;
			}

			case 'stream_control': {
				this.emit('stream:control', message);
				break;
			}

			case 'error': {
				this.emit('client:error', message);
				break;
			}

			case 'health_pong': {
				this.lastPingAt.set(clientId, Date.now());
				break;
			}
		}
	}

	private sendBadMessageError(socket: WebSocket, error: unknown): void {
		if (socket.readyState !== WebSocket.OPEN) {
			return;
		}

		const messageText = error instanceof Error ? error.message : 'Unknown parse error';
		const errorMessage = createMessage<ErrorMessage>('error', {
			code: 'BAD_MESSAGE',
			message: messageText,
		});

		socket.send(serializeMessage(errorMessage));
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
}
