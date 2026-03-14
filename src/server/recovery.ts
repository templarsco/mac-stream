import { EventEmitter } from 'node:events';
import { type ResultPromise, execa } from 'execa';
import {
	INPUT_AGENT_MAX_RESTARTS,
	INPUT_AGENT_RESTART_DELAY_MS,
	INPUT_SOCKET_PATH,
	MEMORY_CHECK_INTERVAL_MS,
	MEMORY_THRESHOLD_MB,
} from '../shared/constants.js';
import type { FFmpegManager } from './ffmpeg-manager.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HealthStatus {
	memoryUsageMb: number;
	memoryThresholdMb: number;
	ffmpegRunning: boolean;
	inputAgentRunning: boolean;
	uptimeMs: number;
}

interface RecoveryManagerConfig {
	ffmpegManager: FFmpegManager;
	inputSocketPath?: string;
	memoryThresholdMb?: number;
	memoryCheckIntervalMs?: number;
}

interface RestartEventPayload {
	component: 'ffmpeg' | 'input-agent';
	reason: string;
	attempt?: number;
	delayMs?: number;
}

interface WarningEventPayload {
	component: 'memory';
	message: string;
	memoryUsageMb: number;
	thresholdMb: number;
}

interface RecoveryManagerEvents {
	warning: [payload: WarningEventPayload];
	restart: [payload: RestartEventPayload];
	error: [error: Error];
}

interface InputAgentProcess extends Pick<ResultPromise, 'kill' | 'killed' | 'exitCode'> {
	on(eventName: 'error', listener: (error: Error) => void): this;
	on(eventName: 'exit', listener: (code: number | null, signal: string | null) => void): this;
	removeAllListeners(): this;
}

// ─── Recovery Manager ────────────────────────────────────────────────────────

export class RecoveryManager extends EventEmitter {
	private readonly ffmpegManager: FFmpegManager;
	private readonly inputSocketPath: string;
	private readonly memoryThresholdMb: number;
	private readonly memoryCheckIntervalMs: number;
	private readonly inputAgentFactory: (command: string) => InputAgentProcess;
	private readonly memoryUsageProvider: () => NodeJS.MemoryUsage;

	private startedAt = 0;
	private isStarted = false;
	private isDisposed = false;

	private inputAgentProcess: InputAgentProcess | null = null;
	private inputRestartTimer: ReturnType<typeof setTimeout> | null = null;
	private inputRestartAttempts = 0;

	private memoryTimer: ReturnType<typeof setInterval> | null = null;
	private memoryWarningActive = false;
	private memoryRestartInFlight = false;

	constructor(
		config: RecoveryManagerConfig,
		dependencies?: {
			inputAgentFactory?: (command: string) => InputAgentProcess;
			memoryUsageProvider?: () => NodeJS.MemoryUsage;
		},
	) {
		super();
		this.ffmpegManager = config.ffmpegManager;
		this.inputSocketPath = config.inputSocketPath ?? INPUT_SOCKET_PATH;
		this.memoryThresholdMb = config.memoryThresholdMb ?? MEMORY_THRESHOLD_MB;
		this.memoryCheckIntervalMs = config.memoryCheckIntervalMs ?? MEMORY_CHECK_INTERVAL_MS;
		this.inputAgentFactory =
			dependencies?.inputAgentFactory ??
			((command) =>
				execa(command, [], {
					reject: false,
					stdio: 'ignore',
				}) as unknown as InputAgentProcess);
		this.memoryUsageProvider = dependencies?.memoryUsageProvider ?? process.memoryUsage;
	}

	// ─── Typed Event API ───────────────────────────────────────────────────────

	override on<E extends keyof RecoveryManagerEvents>(
		eventName: E,
		listener: (...args: RecoveryManagerEvents[E]) => void,
	): this {
		return super.on(eventName, listener);
	}

	override emit<E extends keyof RecoveryManagerEvents>(
		eventName: E,
		...args: RecoveryManagerEvents[E]
	): boolean {
		return super.emit(eventName, ...args);
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	start(): void {
		if (this.isStarted || this.isDisposed) {
			return;
		}

		this.isStarted = true;
		this.startedAt = Date.now();

		this.startInputAgent();
		void this.startMemoryMonitoring();
	}

	stop(): void {
		if (!this.isStarted) {
			return;
		}

		this.isStarted = false;
		this.clearInputRestartTimer();
		this.stopMemoryMonitoring();
		this.stopInputAgent();
	}

	dispose(): void {
		if (this.isDisposed) {
			return;
		}

		this.stop();
		this.isDisposed = true;
		this.removeAllListeners();
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	async handleKeyframeRequest(): Promise<void> {
		this.emit('restart', {
			component: 'ffmpeg',
			reason: 'keyframe_request',
		});

		try {
			await this.ffmpegManager.restart();
		} catch (error) {
			this.emit('error', this.toError(error, 'Failed to restart FFmpeg for keyframe request'));
		}
	}

	getHealthStatus(): HealthStatus {
		const memoryUsageMb = this.getMemoryUsageMb();
		return {
			memoryUsageMb,
			memoryThresholdMb: this.memoryThresholdMb,
			ffmpegRunning: this.ffmpegManager.getState() === 'running',
			inputAgentRunning: this.isInputAgentRunning(),
			uptimeMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt,
		};
	}

	// ─── Input Agent Supervision ──────────────────────────────────────────────

	private startInputAgent(): void {
		if (!this.isStarted || this.isInputAgentRunning()) {
			return;
		}

		try {
			const processHandle = this.inputAgentFactory(this.inputSocketPath);
			this.inputAgentProcess = processHandle;

			processHandle.on('error', (error) => {
				this.inputAgentProcess = null;
				this.emit('error', this.toError(error, 'Input agent process error'));
				this.scheduleInputRestart('process_error');
			});

			processHandle.on('exit', (code, signal) => {
				this.inputAgentProcess = null;
				if (!this.isStarted) {
					return;
				}

				const reason = `process_exit(code=${code}, signal=${signal})`;
				this.scheduleInputRestart(reason);
			});
		} catch (error) {
			this.emit('error', this.toError(error, 'Failed to start input agent'));
			this.scheduleInputRestart('start_failure');
		}
	}

	private stopInputAgent(): void {
		if (!this.inputAgentProcess) {
			return;
		}

		this.inputAgentProcess.removeAllListeners();
		this.inputAgentProcess.kill('SIGTERM');
		this.inputAgentProcess = null;
	}

	private scheduleInputRestart(reason: string): void {
		if (!this.isStarted) {
			return;
		}

		if (this.inputRestartAttempts >= INPUT_AGENT_MAX_RESTARTS) {
			this.emit(
				'error',
				new Error(`Input agent max restart attempts (${INPUT_AGENT_MAX_RESTARTS}) reached`),
			);
			return;
		}

		const delayMs = INPUT_AGENT_RESTART_DELAY_MS * 2 ** this.inputRestartAttempts;
		this.inputRestartAttempts += 1;

		this.emit('restart', {
			component: 'input-agent',
			reason,
			attempt: this.inputRestartAttempts,
			delayMs,
		});

		this.clearInputRestartTimer();
		this.inputRestartTimer = setTimeout(() => {
			this.inputRestartTimer = null;
			this.startInputAgent();
		}, delayMs);
	}

	private clearInputRestartTimer(): void {
		if (this.inputRestartTimer !== null) {
			clearTimeout(this.inputRestartTimer);
			this.inputRestartTimer = null;
		}
	}

	private isInputAgentRunning(): boolean {
		if (!this.inputAgentProcess) {
			return false;
		}

		return !this.inputAgentProcess.killed && this.inputAgentProcess.exitCode === null;
	}

	// ─── Memory Monitoring ─────────────────────────────────────────────────────

	private async startMemoryMonitoring(): Promise<void> {
		this.stopMemoryMonitoring();
		await this.checkMemoryUsage();

		this.memoryTimer = setInterval(() => {
			void this.checkMemoryUsage();
		}, this.memoryCheckIntervalMs);
	}

	private stopMemoryMonitoring(): void {
		if (this.memoryTimer !== null) {
			clearInterval(this.memoryTimer);
			this.memoryTimer = null;
		}
		this.memoryWarningActive = false;
		this.memoryRestartInFlight = false;
	}

	private async checkMemoryUsage(): Promise<void> {
		const memoryUsageMb = this.getMemoryUsageMb();
		const warningThresholdMb = this.memoryThresholdMb * 0.8;

		if (memoryUsageMb >= warningThresholdMb && !this.memoryWarningActive) {
			this.memoryWarningActive = true;
			this.emit('warning', {
				component: 'memory',
				message: `Memory usage high: ${memoryUsageMb.toFixed(1)}MB / ${this.memoryThresholdMb}MB`,
				memoryUsageMb,
				thresholdMb: this.memoryThresholdMb,
			});
		} else if (memoryUsageMb < warningThresholdMb) {
			this.memoryWarningActive = false;
		}

		if (memoryUsageMb < this.memoryThresholdMb || this.memoryRestartInFlight) {
			return;
		}

		this.memoryRestartInFlight = true;
		this.emit('restart', {
			component: 'ffmpeg',
			reason: 'memory_threshold_exceeded',
		});

		try {
			await this.ffmpegManager.restart();
		} catch (error) {
			this.emit('error', this.toError(error, 'Failed to restart FFmpeg on memory threshold'));
		} finally {
			this.memoryRestartInFlight = false;
		}
	}

	private getMemoryUsageMb(): number {
		return this.memoryUsageProvider().rss / (1024 * 1024);
	}

	private toError(error: unknown, fallbackMessage: string): Error {
		if (error instanceof Error) {
			return error;
		}

		return new Error(fallbackMessage);
	}
}
