import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_POLL_MS } from '../src/shared/constants.js';

const electronMocks = vi.hoisted(() => {
	return {
		readText: vi.fn<() => string>(),
		writeText: vi.fn<(content: string) => void>(),
	};
});

vi.mock('electron', () => {
	return {
		clipboard: {
			readText: electronMocks.readText,
			writeText: electronMocks.writeText,
		},
	};
});

import { ClipboardSync } from '../src/client/clipboard.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tick(intervalMs = CLIPBOARD_POLL_MS): Promise<void> {
	await vi.advanceTimersByTimeAsync(intervalMs);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ClipboardSync', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		electronMocks.readText.mockReset();
		electronMocks.writeText.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('start/stop lifecycle controls polling', async () => {
		electronMocks.readText.mockReturnValue('alpha');
		const sendClipboard = vi.fn<(content: string) => void>();
		const sync = new ClipboardSync({ sendClipboard });

		sync.start();
		await tick();
		expect(electronMocks.readText).toHaveBeenCalledTimes(1);

		sync.stop();
		await tick();
		expect(electronMocks.readText).toHaveBeenCalledTimes(1);
	});

	it('sends clipboard content only when hash changes', async () => {
		electronMocks.readText.mockReturnValue('same');
		const sendClipboard = vi.fn<(content: string) => void>();
		const sync = new ClipboardSync({ sendClipboard });

		sync.start();
		await tick();
		await tick();
		await tick();

		expect(sendClipboard).toHaveBeenCalledTimes(1);
		expect(sendClipboard).toHaveBeenCalledWith('same');
	});

	it('sends new content when clipboard changes', async () => {
		electronMocks.readText
			.mockReturnValueOnce('one')
			.mockReturnValueOnce('two')
			.mockReturnValue('two');
		const sendClipboard = vi.fn<(content: string) => void>();
		const sync = new ClipboardSync({ sendClipboard });

		sync.start();
		await tick();
		await tick();
		await tick();

		expect(sendClipboard).toHaveBeenNthCalledWith(1, 'one');
		expect(sendClipboard).toHaveBeenNthCalledWith(2, 'two');
		expect(sendClipboard).toHaveBeenCalledTimes(2);
	});

	it('suppresses callback for next poll after writeRemoteContent', async () => {
		electronMocks.readText
			.mockReturnValueOnce('initial')
			.mockReturnValueOnce('remote-value')
			.mockReturnValue('remote-value');
		const sendClipboard = vi.fn<(content: string) => void>();
		const sync = new ClipboardSync({ sendClipboard });

		sync.start();
		await tick();
		expect(sendClipboard).toHaveBeenCalledTimes(1);
		expect(sendClipboard).toHaveBeenLastCalledWith('initial');

		sync.writeRemoteContent('remote-value');
		expect(electronMocks.writeText).toHaveBeenCalledWith('remote-value');

		await tick();
		await tick();

		expect(sendClipboard).toHaveBeenCalledTimes(1);
	});

	it('readLocalClipboard returns current clipboard text', () => {
		electronMocks.readText.mockReturnValue('from-clipboard');
		const sync = new ClipboardSync({
			sendClipboard: vi.fn<(content: string) => void>(),
		});

		expect(sync.readLocalClipboard()).toBe('from-clipboard');
	});

	it('dispose stops polling and is safe to call repeatedly', async () => {
		electronMocks.readText.mockReturnValue('value');
		const sync = new ClipboardSync({
			sendClipboard: vi.fn<(content: string) => void>(),
		});

		sync.start();
		await tick();
		expect(electronMocks.readText).toHaveBeenCalledTimes(1);

		sync.dispose();
		sync.dispose();

		await tick();
		expect(electronMocks.readText).toHaveBeenCalledTimes(1);
	});

	it('uses custom polling interval when provided', async () => {
		electronMocks.readText.mockReturnValue('value');
		const sync = new ClipboardSync({
			sendClipboard: vi.fn<(content: string) => void>(),
			pollIntervalMs: 250,
		});

		sync.start();
		await vi.advanceTimersByTimeAsync(249);
		expect(electronMocks.readText).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(electronMocks.readText).toHaveBeenCalledTimes(1);
	});
});
