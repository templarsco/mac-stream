import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
	DEFAULT_BITRATE,
	DEFAULT_CRF,
	DEFAULT_FPS,
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BACKOFF_MULTIPLIER,
	RECONNECT_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
	VIDEO_PORT,
} from '../shared/constants.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FFmpegConfig {
	fps: number;
	width: number;
	height: number;
	bitrate: number;
	crf: number;
	displayIndex: number;
	clientIp: string;
	videoPort: number;
}

export interface FFmpegStats {
	frame: number;
	fps: number;
	bitrate: string;
	speed: string;
	time: string;
	droppedFrames: number;
}

export type FFmpegState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

// ─── Constants ───────────────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 3_000;

// FFmpeg stderr progress line fields
const FRAME_REGEX = /frame=\s*(\d+)/;
const FPS_REGEX = /fps=\s*([\d.]+)/;
const BITRATE_REGEX = /bitrate=\s*([\d.]+\S+)/;
const SPEED_REGEX = /speed=\s*([\d.]+x?)/;
const TIME_REGEX = /time=\s*([\d:.]+)/;
const DROP_REGEX = /drop=\s*(\d+)/;

// ─── FFmpegManager ───────────────────────────────────────────────────────────

export class FFmpegManager extends EventEmitter {
	private config: FFmpegConfig;
	private process: ChildProcess | null = null;
	private currentState: FFmpegState = 'stopped';
	private latestStats: FFmpegStats | null = null;
	private restartCount = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private autoRestart = true;
	private readonly spawnFn: typeof spawn;

	constructor(
		config: Partial<FFmpegConfig> & Pick<FFmpegConfig, 'clientIp'>,
		spawnFn?: typeof spawn,
	) {
		super();
		this.config = {
			fps: config.fps ?? DEFAULT_FPS,
			width: config.width ?? DEFAULT_WIDTH,
			height: config.height ?? DEFAULT_HEIGHT,
			bitrate: config.bitrate ?? DEFAULT_BITRATE,
			crf: config.crf ?? DEFAULT_CRF,
			displayIndex: config.displayIndex ?? 1,
			clientIp: config.clientIp,
			videoPort: config.videoPort ?? VIDEO_PORT,
		};
		this.spawnFn = spawnFn ?? spawn;
	}

	// ─── Accessors ─────────────────────────────────────────────────────────────

	getState(): FFmpegState {
		return this.currentState;
	}

	getStats(): FFmpegStats | null {
		return this.latestStats;
	}

	getConfig(): Readonly<FFmpegConfig> {
		return { ...this.config };
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	/**
	 * Constructs FFmpeg CLI arguments for avfoundation capture → x264 encode → mpegts/UDP output.
	 */
	buildArgs(): string[] {
		const { fps, crf, bitrate, displayIndex, clientIp, videoPort } = this.config;
		return [
			// Input: macOS screen capture via avfoundation
			'-f',
			'avfoundation',
			'-framerate',
			String(fps),
			'-capture_cursor',
			'1',
			'-capture_mouse_clicks',
			'1',
			'-pixel_format',
			'uyvy422',
			'-i',
			`${displayIndex}:none`,

			// Encoding: x264 ultrafast for low-latency software encoding
			'-c:v',
			'libx264',
			'-preset',
			'ultrafast',
			'-tune',
			'zerolatency',
			'-crf',
			String(crf),
			'-g',
			String(fps * 2), // Keyframe every 2 seconds
			'-bf',
			'0', // No B-frames for low latency
			'-pix_fmt',
			'yuv420p',
			'-maxrate',
			`${bitrate}k`,
			'-bufsize',
			`${bitrate}k`, // 1-second buffer = bitrate

			// Output: MPEG-TS over UDP
			'-f',
			'mpegts',
			`udp://${clientIp}:${videoPort}?pkt_size=1316`,
		];
	}

	/**
	 * Starts FFmpeg process. No-op if already running or starting.
	 */
	start(): void {
		if (this.currentState === 'running' || this.currentState === 'starting') {
			return;
		}

		this.setState('starting');
		this.autoRestart = true;

		const args = this.buildArgs();
		this.emit('log', `ffmpeg ${args.join(' ')}`);
		const proc = this.spawnFn('ffmpeg', args, {
			stdio: ['ignore', 'ignore', 'pipe'],
		});

		this.process = proc;

		proc.stderr?.on('data', (chunk: Buffer) => {
			this.parseStderr(chunk.toString());
		});

		proc.on('spawn', () => {
			this.setState('running');
			this.restartCount = 0;
			this.emit('started');
		});

		proc.on('error', (err: Error) => {
			this.process = null;
			this.setState('error');
			this.emit('error', err);
			this.scheduleRestart();
		});

		proc.on('close', (code: number | null, signal: string | null) => {
			this.process = null;

			if (this.currentState === 'stopping') {
				this.setState('stopped');
				this.emit('stopped', code, signal);
				return;
			}

			// Unexpected exit — treat as error
			this.setState('error');
			this.emit('stopped', code, signal);
			this.scheduleRestart();
		});
	}

	/**
	 * Gracefully stops FFmpeg: SIGTERM → wait 3s → SIGKILL.
	 */
	async stop(): Promise<void> {
		this.autoRestart = false;
		this.clearRestartTimer();

		if (!this.process || this.currentState === 'stopped') {
			this.setState('stopped');
			return;
		}

		this.setState('stopping');

		return new Promise<void>((resolve) => {
			const proc = this.process;
			if (!proc) {
				this.setState('stopped');
				resolve();
				return;
			}

			const forceKillTimer = setTimeout(() => {
				proc.kill('SIGKILL');
			}, SHUTDOWN_TIMEOUT_MS);

			proc.once('close', () => {
				clearTimeout(forceKillTimer);
				this.process = null;
				this.setState('stopped');
				resolve();
			});

			proc.kill('SIGTERM');
		});
	}

	/**
	 * Stops and restarts FFmpeg with current config.
	 */
	async restart(): Promise<void> {
		await this.stop();
		this.autoRestart = true;
		this.start();
	}

	/**
	 * Updates configuration. Requires restart to take effect.
	 */
	updateConfig(config: Partial<FFmpegConfig>): void {
		this.config = { ...this.config, ...config };
	}

	// ─── Private ───────────────────────────────────────────────────────────────

	private setState(state: FFmpegState): void {
		if (this.currentState !== state) {
			this.currentState = state;
			this.emit('stateChange', state);
		}
	}

	private parseStderr(data: string): void {
		const frameMatch = FRAME_REGEX.exec(data);
		const fpsMatch = FPS_REGEX.exec(data);

		// If not a stats progress line, emit as log for diagnostics
		if (!frameMatch || !fpsMatch) {
			const trimmed = data.trim();
			if (trimmed) {
				this.emit('log', trimmed);
			}
			return;
		}

		const bitrateMatch = BITRATE_REGEX.exec(data);
		const speedMatch = SPEED_REGEX.exec(data);
		const timeMatch = TIME_REGEX.exec(data);
		const dropMatch = DROP_REGEX.exec(data);

		const stats: FFmpegStats = {
			frame: Number.parseInt(frameMatch[1], 10),
			fps: Number.parseFloat(fpsMatch[1]),
			bitrate: bitrateMatch?.[1] ?? '0kbits/s',
			speed: speedMatch?.[1] ?? '0x',
			time: timeMatch?.[1] ?? '00:00:00.00',
			droppedFrames: dropMatch ? Number.parseInt(dropMatch[1], 10) : 0,
		};

		this.latestStats = stats;
		this.emit('stats', stats);
	}

	private scheduleRestart(): void {
		if (!this.autoRestart) {
			return;
		}

		if (this.restartCount >= MAX_RECONNECT_ATTEMPTS) {
			this.emit('error', new Error(`Max restart attempts (${MAX_RECONNECT_ATTEMPTS}) reached`));
			return;
		}

		const delay = Math.min(
			RECONNECT_DELAY_MS * RECONNECT_BACKOFF_MULTIPLIER ** this.restartCount,
			RECONNECT_MAX_DELAY_MS,
		);

		this.restartCount++;
		this.emit('restart', this.restartCount);

		this.restartTimer = setTimeout(() => {
			this.start();
		}, delay);
	}

	private clearRestartTimer(): void {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
	}
}
