#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
	DEFAULT_BITRATE,
	DEFAULT_CRF,
	DEFAULT_FPS,
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	MEMORY_CHECK_INTERVAL_MS,
	MEMORY_THRESHOLD_MB,
	VIDEO_PORT,
	WS_PORT,
} from '../shared/constants.js';
import type { ClipboardUpdateMessage, InputEventMessage } from '../shared/protocol.js';
import { createMessage } from '../shared/protocol.js';
import { ClipboardMonitor } from './clipboard.js';
import { FFmpegManager } from './ffmpeg-manager.js';
import { InputBridge } from './input-bridge.js';
import { RecoveryManager } from './recovery.js';
import { MacStreamWebSocketServer } from './websocket.js';

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function printUsage(): void {
	console.log(`
MacStream Server — Screen streaming service for macOS

Usage:
  npx tsx src/server/index.ts --client-ip <ip> [options]

Required:
  --client-ip <ip>      Client IP address to stream to

Options:
  --port <number>       WebSocket port (default: ${WS_PORT})
  --video-port <number> UDP video port (default: ${VIDEO_PORT})
  --fps <number>        Capture framerate (default: ${DEFAULT_FPS})
  --width <number>      Output width (default: ${DEFAULT_WIDTH})
  --height <number>     Output height (default: ${DEFAULT_HEIGHT})
  --bitrate <number>    Max bitrate in kbps (default: ${DEFAULT_BITRATE})
  --crf <number>        CRF quality value (default: ${DEFAULT_CRF})
  --display <number>    Display index for avfoundation (default: 1)
  --help                Show this help message
`);
}

const { values } = parseArgs({
	options: {
		'client-ip': { type: 'string' },
		port: { type: 'string', default: String(WS_PORT) },
		'video-port': { type: 'string', default: String(VIDEO_PORT) },
		fps: { type: 'string', default: String(DEFAULT_FPS) },
		width: { type: 'string', default: String(DEFAULT_WIDTH) },
		height: { type: 'string', default: String(DEFAULT_HEIGHT) },
		bitrate: { type: 'string', default: String(DEFAULT_BITRATE) },
		crf: { type: 'string', default: String(DEFAULT_CRF) },
		display: { type: 'string', default: '1' },
		help: { type: 'boolean', default: false },
	},
	strict: true,
});

if (values.help) {
	printUsage();
	process.exit(0);
}

if (!values['client-ip']) {
	console.error('Error: --client-ip is required.\n');
	printUsage();
	process.exit(1);
}

// ─── Configuration ───────────────────────────────────────────────────────────

const config = {
	clientIp: values['client-ip'],
	wsPort: Number(values.port),
	videoPort: Number(values['video-port']),
	fps: Number(values.fps),
	width: Number(values.width),
	height: Number(values.height),
	bitrate: Number(values.bitrate),
	crf: Number(values.crf),
	displayIndex: Number(values.display),
};

// ─── Component Initialization ────────────────────────────────────────────────

const ffmpeg = new FFmpegManager({
	clientIp: config.clientIp,
	fps: config.fps,
	width: config.width,
	height: config.height,
	bitrate: config.bitrate,
	crf: config.crf,
	displayIndex: config.displayIndex,
	videoPort: config.videoPort,
});

const recovery = new RecoveryManager({
	ffmpegManager: ffmpeg,
	memoryThresholdMb: MEMORY_THRESHOLD_MB,
	memoryCheckIntervalMs: MEMORY_CHECK_INTERVAL_MS,
});

// FFmpeg lifecycle logging
ffmpeg.on('started', () => {
	console.log('[ffmpeg] Streaming started');
});

ffmpeg.on('stopped', (code: number | null, signal: string | null) => {
	console.log(`[ffmpeg] Process exited (code=${code}, signal=${signal})`);
});

ffmpeg.on('error', (err: Error) => {
	console.error(`[ffmpeg] Error: ${err.message}`);
});

ffmpeg.on('restart', (attempt: number) => {
	console.log(`[ffmpeg] Scheduling restart (attempt ${attempt})`);
});

ffmpeg.on('stats', (stats) => {
	if (stats.frame % 300 === 0) {
		console.log(
			`[ffmpeg] frame=${stats.frame} fps=${stats.fps} bitrate=${stats.bitrate} dropped=${stats.droppedFrames}`,
		);
	}
});

recovery.on('warning', (warning) => {
	console.warn(`[recovery] ${warning.message}`);
});

recovery.on('restart', (event) => {
	if (event.component === 'input-agent') {
		console.log(
			`[recovery] restart component=${event.component} attempt=${event.attempt} delayMs=${event.delayMs} reason=${event.reason}`,
		);
		return;
	}

	console.log(`[recovery] restart component=${event.component} reason=${event.reason}`);
});

recovery.on('error', (error: Error) => {
	console.error(`[recovery] Error: ${error.message}`);
});

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wsServer = new MacStreamWebSocketServer({ port: config.wsPort });

wsServer.on('connection', (clientId: string) => {
	console.log(`[ws] Client connected: ${clientId}`);
});

wsServer.on('disconnection', (clientId: string) => {
	console.log(`[ws] Client disconnected: ${clientId}`);
});

wsServer.on('error', (event: { clientId: string | null; error: Error }) => {
	console.error(`[ws] Error (client=${event.clientId ?? 'server'}): ${event.error.message}`);
});

wsServer.on('stateChange', (state: string) => {
	console.log(`[ws] State: ${state}`);
});

// ─── Clipboard Monitor ──────────────────────────────────────────────────────

const clipboard = new ClipboardMonitor();

clipboard.on('change', (event: { content: string; format: 'text' }) => {
	const message = createMessage<ClipboardUpdateMessage>('clipboard_update', {
		content: event.content,
		format: event.format,
	});
	wsServer.broadcast(message);
});

clipboard.on('error', (error: Error) => {
	console.error(`[clipboard] Error: ${error.message}`);
});

// Handle clipboard updates from clients
wsServer.on('clipboard:update', (message: ClipboardUpdateMessage) => {
	if (message.format === 'text') {
		void clipboard.writeClipboard(message.content);
	}
});

// ─── Input Bridge ────────────────────────────────────────────────────────────

const inputBridge = new InputBridge({
	screenWidth: config.width,
	screenHeight: config.height,
});

inputBridge.on('connected', () => {
	console.log('[input] Connected to Swift input agent');
});

inputBridge.on('disconnected', () => {
	console.log('[input] Disconnected from Swift input agent');
});

inputBridge.on('error', (error: Error) => {
	console.error(`[input] Error: ${error.message}`);
});

inputBridge.on('reconnect', (info: { attempt: number; delay: number }) => {
	console.log(`[input] Reconnecting (attempt ${info.attempt}, delay ${info.delay}ms)`);
});

// Forward input events from WebSocket clients to Swift agent
wsServer.on('input', (message: InputEventMessage) => {
	inputBridge.sendEvent(message.event);
});

// Handle keyframe requests from clients
wsServer.on('keyframe:request', (_clientId: string) => {
	// FFmpeg doesn't support on-demand keyframes easily with avfoundation;
	// the ultrafast preset produces frequent keyframes by default.
	console.log('[ws] Keyframe requested (handled by encoder GOP settings)');
});

// ─── Start ───────────────────────────────────────────────────────────────────

console.log('[macstream] Starting server...');
console.log(`[macstream] Client IP: ${config.clientIp}`);
console.log(`[macstream] Video: udp://${config.clientIp}:${config.videoPort}`);
console.log(`[macstream] WS port: ${config.wsPort}`);
console.log(
	`[macstream] Capture: ${config.width}x${config.height}@${config.fps}fps, bitrate=${config.bitrate}k, crf=${config.crf}`,
);

async function startServer(): Promise<void> {
	try {
		await wsServer.start();
		console.log(`[macstream] WebSocket server listening on port ${config.wsPort}`);
	} catch (error) {
		console.error('[macstream] Failed to start WebSocket server:', error);
		process.exit(1);
	}

	ffmpeg.start();
	recovery.start();
	clipboard.start();
	inputBridge.connect();

	console.log('[macstream] All components started');
}

void startServer();

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
	console.log(`\n[macstream] Received ${signal}, shutting down...`);

	clipboard.stop();
	inputBridge.disconnect();
	await wsServer.close();
	await ffmpeg.stop();
	recovery.stop();

	console.log('[macstream] Shutdown complete');
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
