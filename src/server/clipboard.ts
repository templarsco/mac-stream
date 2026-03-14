import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import clipboard from 'clipboardy';
import { CLIPBOARD_POLL_MS } from '../shared/constants.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClipboardMonitorOptions {
	pollIntervalMs?: number;
}

type ClipboardReadFn = () => Promise<string>;
type ClipboardWriteFn = (text: string) => Promise<void>;

interface ClipboardChangeEvent {
	content: string;
	format: 'text';
}

// ─── ClipboardMonitor ────────────────────────────────────────────────────────

export class ClipboardMonitor extends EventEmitter {
	private readonly pollIntervalMs: number;
	private readonly readFn: ClipboardReadFn;
	private readonly writeFn: ClipboardWriteFn;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastHash: string | null = null;
	private lastContent: string | null = null;
	private suppressNextWriteHash: string | null = null;

	constructor(
		options: ClipboardMonitorOptions = {},
		readFn?: ClipboardReadFn,
		writeFn?: ClipboardWriteFn,
	) {
		super();
		this.pollIntervalMs = options.pollIntervalMs ?? CLIPBOARD_POLL_MS;
		this.readFn = readFn ?? clipboard.read;
		this.writeFn = writeFn ?? clipboard.write;
	}

	// ─── Accessors ─────────────────────────────────────────────────────────────

	isRunning(): boolean {
		return this.pollTimer !== null;
	}

	getLastContent(): string | null {
		return this.lastContent;
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	start(): void {
		if (this.pollTimer) {
			return;
		}

		this.pollTimer = setInterval(() => {
			void this.pollClipboard();
		}, this.pollIntervalMs);
	}

	stop(): void {
		if (!this.pollTimer) {
			return;
		}

		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	async writeClipboard(content: string): Promise<void> {
		try {
			await this.writeFn(content);
			this.suppressNextWriteHash = this.hashContent(content);
		} catch (error) {
			this.emit('error', error);
			throw error;
		}
	}

	// ─── Private ───────────────────────────────────────────────────────────────

	private async pollClipboard(): Promise<void> {
		try {
			const content = await this.readFn();
			const contentHash = this.hashContent(content);

			if (this.lastHash === contentHash) {
				return;
			}

			if (this.suppressNextWriteHash && this.suppressNextWriteHash === contentHash) {
				this.lastHash = contentHash;
				this.suppressNextWriteHash = null;
				return;
			}

			this.suppressNextWriteHash = null;
			this.lastHash = contentHash;
			this.lastContent = content;

			const payload: ClipboardChangeEvent = {
				content,
				format: 'text',
			};

			this.emit('change', payload);
		} catch (error) {
			this.emit('error', error);
		}
	}

	private hashContent(content: string): string {
		return createHash('sha256').update(content).digest('hex');
	}
}
