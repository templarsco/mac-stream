import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryManager } from '../src/server/recovery.js';
import {
	INPUT_AGENT_MAX_RESTARTS,
	INPUT_AGENT_RESTART_DELAY_MS,
	MEMORY_CHECK_INTERVAL_MS,
	MEMORY_THRESHOLD_MB,
} from '../src/shared/constants.js';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

type FFmpegState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

class MockFFmpegManager extends EventEmitter {
	state: FFmpegState = 'stopped';
	restart = vi.fn(async () => {
		this.state = 'running';
	});

	getState(): FFmpegState {
		return this.state;
	}
}

class MockInputAgentProcess extends EventEmitter {
	killed = false;
	exitCode: number | null = null;
	kill = vi.fn(() => {
		this.killed = true;
		this.exitCode = 0;
		return true;
	});

	removeAllListeners(): this {
		super.removeAllListeners();
		return this;
	}
}

interface RecoveryHarness {
	recovery: RecoveryManager;
	ffmpeg: MockFFmpegManager;
	spawned: MockInputAgentProcess[];
	memoryRef: { rssMb: number };
}

function createHarness(overrides?: {
	memoryThresholdMb?: number;
	memoryCheckIntervalMs?: number;
}): RecoveryHarness {
	const ffmpeg = new MockFFmpegManager();
	ffmpeg.state = 'running';

	const spawned: MockInputAgentProcess[] = [];
	const memoryRef = { rssMb: 100 };

	const recovery = new RecoveryManager(
		{
			ffmpegManager: ffmpeg as unknown as never,
			inputSocketPath: '/tmp/test-input-agent',
			memoryThresholdMb: overrides?.memoryThresholdMb ?? MEMORY_THRESHOLD_MB,
			memoryCheckIntervalMs: overrides?.memoryCheckIntervalMs ?? MEMORY_CHECK_INTERVAL_MS,
		},
		{
			inputAgentFactory: () => {
				const proc = new MockInputAgentProcess();
				spawned.push(proc);
				return proc;
			},
			memoryUsageProvider: () => {
				const rss = memoryRef.rssMb * 1024 * 1024;
				return {
					rss,
					heapTotal: rss,
					heapUsed: rss / 2,
					external: 0,
					arrayBuffers: 0,
				};
			},
		},
	);

	return {
		recovery,
		ffmpeg,
		spawned,
		memoryRef,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RecoveryManager', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('restarts ffmpeg when keyframe request is handled', async () => {
		const { recovery, ffmpeg } = createHarness();

		const restartEvent = vi.fn();
		recovery.on('restart', restartEvent);

		await recovery.handleKeyframeRequest();

		expect(ffmpeg.restart).toHaveBeenCalledOnce();
		expect(restartEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				component: 'ffmpeg',
				reason: 'keyframe_request',
			}),
		);
	});

	it('restarts input agent with exponential backoff on crash', () => {
		const { recovery, spawned } = createHarness();
		const restartEvent = vi.fn();
		recovery.on('restart', restartEvent);

		recovery.start();
		expect(spawned).toHaveLength(1);

		spawned[0].emit('exit', 1, null);
		expect(restartEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				component: 'input-agent',
				attempt: 1,
				delayMs: INPUT_AGENT_RESTART_DELAY_MS,
			}),
		);

		vi.advanceTimersByTime(INPUT_AGENT_RESTART_DELAY_MS);
		expect(spawned).toHaveLength(2);

		spawned[1].emit('exit', 1, null);
		expect(restartEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				component: 'input-agent',
				attempt: 2,
				delayMs: INPUT_AGENT_RESTART_DELAY_MS * 2,
			}),
		);
	});

	it('stops restarting input agent after max attempts', () => {
		const { recovery, spawned } = createHarness();
		const errorEvent = vi.fn();
		recovery.on('error', errorEvent);

		recovery.start();

		for (let attempt = 0; attempt < INPUT_AGENT_MAX_RESTARTS; attempt++) {
			spawned[attempt].emit('exit', 1, null);
			vi.advanceTimersByTime(INPUT_AGENT_RESTART_DELAY_MS * 2 ** attempt);
		}

		spawned[INPUT_AGENT_MAX_RESTARTS].emit('exit', 1, null);

		expect(errorEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringContaining('max restart attempts'),
			}),
		);
	});

	it('emits warning when memory usage reaches 80% threshold', async () => {
		const { recovery, memoryRef } = createHarness({
			memoryThresholdMb: 100,
			memoryCheckIntervalMs: 1000,
		});
		const warningEvent = vi.fn();
		recovery.on('warning', warningEvent);

		recovery.start();

		memoryRef.rssMb = 85;
		await vi.advanceTimersByTimeAsync(1000);

		expect(warningEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				component: 'memory',
				thresholdMb: 100,
			}),
		);
	});

	it('restarts ffmpeg when memory threshold is exceeded', async () => {
		const { recovery, ffmpeg, memoryRef } = createHarness({
			memoryThresholdMb: 100,
			memoryCheckIntervalMs: 1000,
		});
		const restartEvent = vi.fn();
		recovery.on('restart', restartEvent);

		recovery.start();

		memoryRef.rssMb = 110;
		await vi.advanceTimersByTimeAsync(1000);

		expect(ffmpeg.restart).toHaveBeenCalled();
		expect(restartEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				component: 'ffmpeg',
				reason: 'memory_threshold_exceeded',
			}),
		);
	});

	it('reports health status fields accurately', () => {
		const { recovery, ffmpeg, memoryRef, spawned } = createHarness({
			memoryThresholdMb: 256,
		});

		memoryRef.rssMb = 64;
		ffmpeg.state = 'running';
		recovery.start();

		expect(spawned).toHaveLength(1);
		const status = recovery.getHealthStatus();

		expect(status.memoryUsageMb).toBeCloseTo(64, 4);
		expect(status.memoryThresholdMb).toBe(256);
		expect(status.ffmpegRunning).toBe(true);
		expect(status.inputAgentRunning).toBe(true);
		expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
	});

	it('supports start/stop/dispose lifecycle', () => {
		const { recovery, spawned } = createHarness();

		recovery.start();
		expect(spawned).toHaveLength(1);

		recovery.stop();
		expect(spawned[0].kill).toHaveBeenCalledWith('SIGTERM');

		recovery.start();
		expect(spawned).toHaveLength(2);

		recovery.dispose();
		expect(spawned[1].kill).toHaveBeenCalledWith('SIGTERM');

		recovery.start();
		expect(spawned).toHaveLength(2);
	});
});
