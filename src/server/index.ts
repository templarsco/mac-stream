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
import { FFmpegManager } from './ffmpeg-manager.js';
import { RecoveryManager } from './recovery.js';

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

// TODO: Task 2.1 — Initialize WebSocket server on config.wsPort
// TODO: Task 2.2 — Initialize clipboard monitor

// ─── Start ───────────────────────────────────────────────────────────────────

console.log('[macstream] Starting server...');
console.log(`[macstream] Client IP: ${config.clientIp}`);
console.log(`[macstream] Video: udp://${config.clientIp}:${config.videoPort}`);
console.log(`[macstream] WS port: ${config.wsPort}`);
console.log(
	`[macstream] Capture: ${config.width}x${config.height}@${config.fps}fps, bitrate=${config.bitrate}k, crf=${config.crf}`,
);

ffmpeg.start();
recovery.start();

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
	console.log(`\n[macstream] Received ${signal}, shutting down...`);

	// TODO: Close WebSocket server
	// TODO: Stop clipboard monitor

	await ffmpeg.stop();
	recovery.stop();

	console.log('[macstream] Shutdown complete');
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
