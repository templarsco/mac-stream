import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FFmpegManager, type FFmpegStats } from '../src/server/ffmpeg-manager.js';
import {
	DEFAULT_BITRATE,
	DEFAULT_CRF,
	DEFAULT_FPS,
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BACKOFF_MULTIPLIER,
	RECONNECT_DELAY_MS,
	VIDEO_PORT,
} from '../src/shared/constants.js';

// ─── Mock Process Helper ─────────────────────────────────────────────────────

interface MockProcess extends EventEmitter {
	stderr: PassThrough;
	kill: ReturnType<typeof vi.fn>;
	pid: number;
}

function createMockProcess(): MockProcess {
	const proc = new EventEmitter() as MockProcess;
	proc.stderr = new PassThrough();
	proc.kill = vi.fn();
	proc.pid = 12345;
	return proc;
}

type MockSpawnFn = typeof spawn & ReturnType<typeof vi.fn>;

function createMockSpawn(proc: MockProcess): MockSpawnFn {
	return vi.fn(() => proc as unknown as ChildProcess) as MockSpawnFn;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Simulates FFmpeg stderr progress output */
function emitStderr(proc: MockProcess, data: string): void {
	proc.stderr.write(data);
}

/** Simulates the spawned process becoming ready */
function simulateSpawn(proc: MockProcess): void {
	proc.emit('spawn');
}

/** Simulates the process closing */
function simulateClose(proc: MockProcess, code: number | null, signal: string | null): void {
	proc.emit('close', code, signal);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('FFmpegManager', () => {
	let mockProc: MockProcess;
	let mockSpawn: MockSpawnFn;
	let manager: FFmpegManager;

	beforeEach(() => {
		vi.useFakeTimers();
		mockProc = createMockProcess();
		mockSpawn = createMockSpawn(mockProc);
		manager = new FFmpegManager({ clientIp: '192.168.1.100' }, mockSpawn);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ─── buildArgs ─────────────────────────────────────────────────────────────

	describe('buildArgs', () => {
		it('constructs correct arguments with default config', () => {
			const args = manager.buildArgs();

			// Input section
			expect(args).toContain('-f');
			expect(args).toContain('avfoundation');
			expect(args).toContain('-framerate');
			expect(args).toContain(String(DEFAULT_FPS));
			expect(args).toContain('-capture_cursor');
			expect(args).toContain('-capture_mouse_clicks');
			expect(args).toContain('-pixel_format');
			expect(args).toContain('uyvy422');
			expect(args).toContain('-i');
			expect(args).toContain('1:none'); // Default displayIndex=1

			// Encoding section
			expect(args).toContain('-c:v');
			expect(args).toContain('libx264');
			expect(args).toContain('-preset');
			expect(args).toContain('ultrafast');
			expect(args).toContain('-tune');
			expect(args).toContain('zerolatency');
			expect(args).toContain('-crf');
			expect(args).toContain(String(DEFAULT_CRF));
			expect(args).toContain('-bf');
			expect(args).toContain('0');

			// Keyframe interval = fps * 2
			expect(args).toContain('-g');
			expect(args).toContain(String(DEFAULT_FPS * 2));

			// Bitrate
			expect(args).toContain('-maxrate');
			expect(args).toContain(`${DEFAULT_BITRATE}k`);
			expect(args).toContain('-bufsize');
			expect(args).toContain(`${DEFAULT_BITRATE}k`);

			// Output section
			expect(args).toContain('-f');
			expect(args).toContain('mpegts');
			expect(args).toContain(`udp://192.168.1.100:${VIDEO_PORT}?pkt_size=1316`);
		});

		it('uses custom config values', () => {
			const custom = new FFmpegManager(
				{
					clientIp: '10.0.0.5',
					fps: 30,
					width: 1280,
					height: 720,
					bitrate: 3000,
					crf: 28,
					displayIndex: 2,
					videoPort: 9000,
				},
				mockSpawn,
			);

			const args = custom.buildArgs();

			expect(args).toContain(String(30)); // fps
			expect(args).toContain(String(28)); // crf
			expect(args).toContain(String(60)); // keyframe = fps*2
			expect(args).toContain('3000k'); // maxrate
			expect(args).toContain('2:none'); // displayIndex
			expect(args).toContain('udp://10.0.0.5:9000?pkt_size=1316');
		});
	});

	// ─── getConfig ─────────────────────────────────────────────────────────────

	describe('getConfig', () => {
		it('returns full config with defaults populated', () => {
			const config = manager.getConfig();
			expect(config).toEqual({
				fps: DEFAULT_FPS,
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				bitrate: DEFAULT_BITRATE,
				crf: DEFAULT_CRF,
				displayIndex: 1,
				clientIp: '192.168.1.100',
				videoPort: VIDEO_PORT,
			});
		});

		it('returns a copy (not a reference)', () => {
			const config1 = manager.getConfig();
			const config2 = manager.getConfig();
			expect(config1).not.toBe(config2);
			expect(config1).toEqual(config2);
		});
	});

	// ─── Lifecycle: start ──────────────────────────────────────────────────────

	describe('start', () => {
		it('spawns ffmpeg process and transitions to running', () => {
			const stateChanges: string[] = [];
			manager.on('stateChange', (s: string) => stateChanges.push(s));

			manager.start();
			expect(manager.getState()).toBe('starting');

			simulateSpawn(mockProc);
			expect(manager.getState()).toBe('running');
			expect(stateChanges).toEqual(['starting', 'running']);
		});

		it('emits "started" event on spawn', () => {
			const started = vi.fn();
			manager.on('started', started);

			manager.start();
			simulateSpawn(mockProc);

			expect(started).toHaveBeenCalledOnce();
		});

		it('calls spawn with correct command and options', () => {
			manager.start();

			expect(mockSpawn).toHaveBeenCalledWith('ffmpeg', expect.any(Array), {
				stdio: ['ignore', 'ignore', 'pipe'],
			});
		});

		it('is a no-op when already running', () => {
			manager.start();
			simulateSpawn(mockProc);

			manager.start(); // Should not call spawn again
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		it('is a no-op when in starting state', () => {
			manager.start();
			manager.start(); // Still starting, should not call spawn again
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		it('resets restart count on successful spawn', () => {
			manager.start();
			simulateSpawn(mockProc);
			simulateClose(mockProc, 1, null); // Unexpected crash

			// After restart timer fires, creates new process
			const newProc = createMockProcess();
			(mockSpawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
				newProc as unknown as ChildProcess,
			);
			vi.advanceTimersByTime(RECONNECT_DELAY_MS);
			simulateSpawn(newProc);

			// State should be running, restart count should be 0
			expect(manager.getState()).toBe('running');
		});
	});

	// ─── Lifecycle: stop ───────────────────────────────────────────────────────

	describe('stop', () => {
		it('sends SIGTERM and resolves on close', async () => {
			manager.start();
			simulateSpawn(mockProc);

			const stopPromise = manager.stop();
			expect(manager.getState()).toBe('stopping');
			expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

			simulateClose(mockProc, 0, null);
			await stopPromise;

			expect(manager.getState()).toBe('stopped');
		});

		it('emits "stopped" event with exit code', async () => {
			const stopped = vi.fn();
			manager.on('stopped', stopped);

			manager.start();
			simulateSpawn(mockProc);

			const stopPromise = manager.stop();
			simulateClose(mockProc, 0, 'SIGTERM');
			await stopPromise;

			expect(stopped).toHaveBeenCalledWith(0, 'SIGTERM');
		});

		it('sends SIGKILL after 3s timeout', async () => {
			manager.start();
			simulateSpawn(mockProc);

			const stopPromise = manager.stop();
			expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

			// Advance past shutdown timeout
			vi.advanceTimersByTime(3_000);
			expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

			// Process finally closes
			simulateClose(mockProc, null, 'SIGKILL');
			await stopPromise;

			expect(manager.getState()).toBe('stopped');
		});

		it('resolves immediately when already stopped', async () => {
			await manager.stop();
			expect(manager.getState()).toBe('stopped');
		});

		it('resolves immediately when no process exists', async () => {
			await manager.stop();
			expect(manager.getState()).toBe('stopped');
		});

		it('disables auto-restart', async () => {
			const restartFn = vi.fn();
			manager.on('restart', restartFn);

			manager.start();
			simulateSpawn(mockProc);

			const stopPromise = manager.stop();
			simulateClose(mockProc, 0, null);
			await stopPromise;

			// Should not schedule restart
			vi.advanceTimersByTime(60_000);
			expect(restartFn).not.toHaveBeenCalled();
		});
	});

	// ─── Lifecycle: restart ────────────────────────────────────────────────────

	describe('restart', () => {
		it('stops then starts with new process', async () => {
			manager.start();
			simulateSpawn(mockProc);

			const newProc = createMockProcess();
			(mockSpawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
				newProc as unknown as ChildProcess,
			);

			const restartPromise = manager.restart();
			simulateClose(mockProc, 0, null);
			await restartPromise;

			expect(manager.getState()).toBe('starting');
			simulateSpawn(newProc);
			expect(manager.getState()).toBe('running');
		});
	});

	// ─── stderr parsing ────────────────────────────────────────────────────────

	describe('stderr parsing', () => {
		beforeEach(() => {
			manager.start();
			simulateSpawn(mockProc);
		});

		it('emits stats from a full FFmpeg progress line', () => {
			const statsHandler = vi.fn();
			manager.on('stats', statsHandler);

			emitStderr(
				mockProc,
				'frame=  120 fps= 60.0 q=28.0 size=     768kB time=00:00:02.00 bitrate=3145.7kbits/s speed=1.00x\r',
			);

			expect(statsHandler).toHaveBeenCalledOnce();
			const stats: FFmpegStats = statsHandler.mock.calls[0][0];
			expect(stats.frame).toBe(120);
			expect(stats.fps).toBe(60.0);
			expect(stats.bitrate).toBe('3145.7kbits/s');
			expect(stats.speed).toBe('1.00x');
			expect(stats.time).toBe('00:00:02.00');
			expect(stats.droppedFrames).toBe(0);
		});

		it('parses dropped frames count', () => {
			const statsHandler = vi.fn();
			manager.on('stats', statsHandler);

			emitStderr(
				mockProc,
				'frame=  500 fps= 59.2 q=28.0 size=    2048kB time=00:00:08.33 bitrate=2012.1kbits/s drop=3 speed=0.99x\r',
			);

			const stats: FFmpegStats = statsHandler.mock.calls[0][0];
			expect(stats.droppedFrames).toBe(3);
			expect(stats.frame).toBe(500);
		});

		it('does not emit stats for non-progress stderr lines', () => {
			const statsHandler = vi.fn();
			manager.on('stats', statsHandler);

			emitStderr(mockProc, 'Input #0, avfoundation, from "1:none":');
			emitStderr(mockProc, '  Stream #0:0: Video: rawvideo');
			emitStderr(mockProc, 'Output #0, mpegts, to "udp://192.168.1.100:5004":');

			expect(statsHandler).not.toHaveBeenCalled();
		});

		it('updates latestStats accessible via getStats()', () => {
			expect(manager.getStats()).toBeNull();

			emitStderr(
				mockProc,
				'frame=   60 fps= 60.0 q=23.0 size=     384kB time=00:00:01.00 bitrate=3145.7kbits/s speed=1.00x\r',
			);

			const stats = manager.getStats();
			expect(stats).not.toBeNull();
			expect(stats?.frame).toBe(60);
			expect(stats?.fps).toBe(60.0);
		});

		it('handles progress line with minimal whitespace', () => {
			const statsHandler = vi.fn();
			manager.on('stats', statsHandler);

			emitStderr(
				mockProc,
				'frame=1000 fps=30.0 q=28.0 Lsize=4096kB time=00:00:33.33 bitrate=1005.2kbits/s speed=1.00x\r',
			);

			expect(statsHandler).toHaveBeenCalledOnce();
			const stats: FFmpegStats = statsHandler.mock.calls[0][0];
			expect(stats.frame).toBe(1000);
			expect(stats.fps).toBe(30.0);
		});
	});

	// ─── Auto-restart on crash ─────────────────────────────────────────────────

	describe('auto-restart on crash', () => {
		it('schedules restart on unexpected process exit', () => {
			const restartHandler = vi.fn();
			manager.on('restart', restartHandler);

			manager.start();
			simulateSpawn(mockProc);

			// Process crashes
			simulateClose(mockProc, 1, null);

			expect(manager.getState()).toBe('error');
			expect(restartHandler).toHaveBeenCalledWith(1); // First attempt
		});

		it('schedules restart on spawn error', () => {
			const restartHandler = vi.fn();
			manager.on('restart', restartHandler);
			// Must listen for 'error' to prevent Node.js from throwing
			manager.on('error', () => {});

			manager.start();
			mockProc.emit('error', new Error('ENOENT'));

			expect(manager.getState()).toBe('error');
			expect(restartHandler).toHaveBeenCalledWith(1);
		});

		it('applies exponential backoff for restart delays', () => {
			// Suppress manager error events (re-emitted from process)
			manager.on('error', () => {});

			manager.start();
			simulateSpawn(mockProc);

			// First crash → delay = RECONNECT_DELAY_MS * 1.5^0 = 1000ms
			simulateClose(mockProc, 1, null);

			const proc2 = createMockProcess();
			(mockSpawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(proc2 as unknown as ChildProcess);

			vi.advanceTimersByTime(RECONNECT_DELAY_MS - 1);
			expect(mockSpawn).toHaveBeenCalledTimes(1); // Not yet

			vi.advanceTimersByTime(1);
			expect(mockSpawn).toHaveBeenCalledTimes(2); // Now spawned

			// Second crash WITHOUT simulateSpawn → restartCount stays accumulated
			// delay = 1000 * 1.5^1 = 1500ms (restartCount was 1 before this crash)
			simulateClose(proc2, 1, null);

			const proc3 = createMockProcess();
			(mockSpawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(proc3 as unknown as ChildProcess);

			const secondDelay = RECONNECT_DELAY_MS * RECONNECT_BACKOFF_MULTIPLIER;
			vi.advanceTimersByTime(secondDelay - 1);
			expect(mockSpawn).toHaveBeenCalledTimes(2); // Not yet
			vi.advanceTimersByTime(1);
			expect(mockSpawn).toHaveBeenCalledTimes(3); // Now spawned
		});

		it('emits error after max restart attempts', () => {
			const errorHandler = vi.fn();
			manager.on('error', errorHandler);

			manager.start();
			simulateSpawn(mockProc);

			// First crash starts the cycle; subsequent crashes accumulate restartCount
			// because we don't call simulateSpawn (restartCount never resets)
			simulateClose(mockProc, 1, null);
			// restartCount=0 → succeeds → restartCount=1

			// Loop produces crashes 2..MAX_RECONNECT_ATTEMPTS
			for (let i = 1; i < MAX_RECONNECT_ATTEMPTS; i++) {
				const nextProc = createMockProcess();
				(mockSpawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
					nextProc as unknown as ChildProcess,
				);

				vi.advanceTimersByTime(60_000); // Advance past any backoff
				simulateClose(nextProc, 1, null);
			}
			// After loop: restartCount=MAX_RECONNECT_ATTEMPTS (10)

			// One more crash cycle triggers the max attempts error
			const finalProc = createMockProcess();
			(mockSpawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
				finalProc as unknown as ChildProcess,
			);
			vi.advanceTimersByTime(60_000);
			simulateClose(finalProc, 1, null);
			// scheduleRestart sees restartCount=10 >= 10 → emits error

			const maxAttemptsError = errorHandler.mock.calls.find(
				(call: unknown[]) =>
					call[0] instanceof Error && call[0].message.includes('Max restart attempts'),
			);
			expect(maxAttemptsError).toBeDefined();
		});
	});

	// ─── updateConfig ──────────────────────────────────────────────────────────

	describe('updateConfig', () => {
		it('updates config values', () => {
			manager.updateConfig({ fps: 30, bitrate: 3000 });
			const config = manager.getConfig();
			expect(config.fps).toBe(30);
			expect(config.bitrate).toBe(3000);
			expect(config.clientIp).toBe('192.168.1.100'); // Unchanged
		});

		it('reflects in next buildArgs call', () => {
			manager.updateConfig({ fps: 30, clientIp: '10.0.0.1' });
			const args = manager.buildArgs();
			expect(args).toContain('30');
			expect(args).toContain('udp://10.0.0.1:5004?pkt_size=1316');
		});
	});

	// ─── State transitions ─────────────────────────────────────────────────────

	describe('state transitions', () => {
		it('starts at stopped', () => {
			expect(manager.getState()).toBe('stopped');
		});

		it('full lifecycle: stopped → starting → running → stopping → stopped', async () => {
			const states: string[] = [];
			manager.on('stateChange', (s: string) => states.push(s));

			manager.start();
			simulateSpawn(mockProc);

			const stopPromise = manager.stop();
			simulateClose(mockProc, 0, null);
			await stopPromise;

			expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
		});

		it('crash lifecycle: stopped → starting → running → error', () => {
			const states: string[] = [];
			manager.on('stateChange', (s: string) => states.push(s));

			manager.start();
			simulateSpawn(mockProc);
			simulateClose(mockProc, 1, null);

			expect(states).toEqual(['starting', 'running', 'error']);
		});
	});
});
