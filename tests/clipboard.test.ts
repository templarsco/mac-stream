import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardMonitor } from '../src/server/clipboard.js';
import { CLIPBOARD_POLL_MS } from '../src/shared/constants.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tickPoll(intervalMs = CLIPBOARD_POLL_MS): Promise<void> {
	await vi.advanceTimersByTimeAsync(intervalMs);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ClipboardMonitor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('start/stop lifecycle toggles polling and running state', async () => {
		const readFn = vi.fn<() => Promise<string>>().mockResolvedValue('alpha');
		const writeFn = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
		const monitor = new ClipboardMonitor({}, readFn, writeFn);

		expect(monitor.isRunning()).toBe(false);

		monitor.start();
		expect(monitor.isRunning()).toBe(true);

		await tickPoll();
		expect(readFn).toHaveBeenCalledTimes(1);

		monitor.start();
		await tickPoll();
		expect(readFn).toHaveBeenCalledTimes(2);

		monitor.stop();
		expect(monitor.isRunning()).toBe(false);

		await tickPoll();
		expect(readFn).toHaveBeenCalledTimes(2);

		monitor.stop();
		expect(monitor.isRunning()).toBe(false);
	});

	it('emits change when read content changes between polls', async () => {
		const readFn = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce('one')
			.mockResolvedValueOnce('two');
		const monitor = new ClipboardMonitor(
			{},
			readFn,
			vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
		);
		const changes: Array<{ content: string; format: 'text' }> = [];

		monitor.on('change', (payload) => {
			changes.push(payload as { content: string; format: 'text' });
		});

		monitor.start();
		await tickPoll();
		await tickPoll();

		expect(changes).toEqual([
			{ content: 'one', format: 'text' },
			{ content: 'two', format: 'text' },
		]);
	});

	it('does not emit duplicate change when content hash is unchanged', async () => {
		const readFn = vi.fn<() => Promise<string>>().mockResolvedValue('same-content');
		const monitor = new ClipboardMonitor(
			{},
			readFn,
			vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
		);
		const onChange = vi.fn();

		monitor.on('change', onChange);
		monitor.start();

		await tickPoll();
		await tickPoll();
		await tickPoll();

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({
			content: 'same-content',
			format: 'text',
		});
	});

	it('suppresses next change event for content written via writeClipboard', async () => {
		const readFn = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce('initial')
			.mockResolvedValueOnce('local-write')
			.mockResolvedValue('local-write');
		const writeFn = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
		const monitor = new ClipboardMonitor({}, readFn, writeFn);
		const onChange = vi.fn();

		monitor.on('change', onChange);
		monitor.start();

		await tickPoll();
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith({
			content: 'initial',
			format: 'text',
		});

		await monitor.writeClipboard('local-write');
		expect(writeFn).toHaveBeenCalledOnce();
		expect(writeFn).toHaveBeenCalledWith('local-write');

		await tickPoll();
		await tickPoll();

		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('emits error on read failure and continues polling', async () => {
		const readFn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('read failed'))
			.mockResolvedValueOnce('recovered-value');
		const monitor = new ClipboardMonitor(
			{},
			readFn,
			vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
		);
		const errors: string[] = [];
		const changes: Array<{ content: string; format: 'text' }> = [];

		monitor.on('error', (error) => {
			errors.push(error instanceof Error ? error.message : String(error));
		});
		monitor.on('change', (payload) => {
			changes.push(payload as { content: string; format: 'text' });
		});

		monitor.start();
		await tickPoll();
		await tickPoll();

		expect(errors).toEqual(['read failed']);
		expect(changes).toEqual([{ content: 'recovered-value', format: 'text' }]);
	});

	it('emits error on write failure and rejects writeClipboard', async () => {
		const writeFn = vi
			.fn<(text: string) => Promise<void>>()
			.mockRejectedValue(new Error('write failed'));
		const monitor = new ClipboardMonitor(
			{},
			vi.fn<() => Promise<string>>().mockResolvedValue('x'),
			writeFn,
		);
		const errors: string[] = [];

		monitor.on('error', (error) => {
			errors.push(error instanceof Error ? error.message : String(error));
		});

		await expect(monitor.writeClipboard('x')).rejects.toThrow('write failed');
		expect(errors).toEqual(['write failed']);
	});

	it('getLastContent returns last content emitted by change event', async () => {
		const readFn = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce('first')
			.mockResolvedValueOnce('second')
			.mockResolvedValue('second');
		const monitor = new ClipboardMonitor(
			{},
			readFn,
			vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
		);

		expect(monitor.getLastContent()).toBeNull();

		monitor.start();
		await tickPoll();
		expect(monitor.getLastContent()).toBe('first');

		await tickPoll();
		expect(monitor.getLastContent()).toBe('second');

		await monitor.writeClipboard('second');
		await tickPoll();
		expect(monitor.getLastContent()).toBe('second');
	});

	it('captures multiple rapid clipboard changes across polls', async () => {
		const values = ['A', 'B', 'C', 'D'];
		let index = 0;
		const readFn = vi.fn<() => Promise<string>>().mockImplementation(async () => {
			const value = values[Math.min(index, values.length - 1)];
			index += 1;
			return value;
		});

		const monitor = new ClipboardMonitor(
			{},
			readFn,
			vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
		);
		const observed: string[] = [];

		monitor.on('change', (payload) => {
			const change = payload as { content: string; format: 'text' };
			observed.push(change.content);
		});

		monitor.start();
		await tickPoll();
		await tickPoll();
		await tickPoll();
		await tickPoll();

		expect(observed).toEqual(['A', 'B', 'C', 'D']);
	});
});
