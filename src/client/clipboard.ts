import { createHash } from 'node:crypto';
import { clipboard } from 'electron';
import { CLIPBOARD_POLL_MS } from '../shared/constants.js';

interface ClipboardSyncOptions {
	sendClipboard: (content: string) => void;
	pollIntervalMs?: number;
}

export class ClipboardSync {
	private readonly sendClipboard: (content: string) => void;
	private readonly pollIntervalMs: number;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastHash: string | null = null;
	private suppressNextWriteHash: string | null = null;

	constructor(options: ClipboardSyncOptions) {
		this.sendClipboard = options.sendClipboard;
		this.pollIntervalMs = options.pollIntervalMs ?? CLIPBOARD_POLL_MS;
	}

	start(): void {
		if (this.pollTimer) {
			return;
		}

		this.pollTimer = setInterval(() => {
			this.pollClipboard();
		}, this.pollIntervalMs);
	}

	stop(): void {
		if (!this.pollTimer) {
			return;
		}

		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	writeRemoteContent(content: string): void {
		clipboard.writeText(content);
		this.suppressNextWriteHash = this.hashContent(content);
	}

	readLocalClipboard(): string {
		return clipboard.readText();
	}

	dispose(): void {
		this.stop();
		this.lastHash = null;
		this.suppressNextWriteHash = null;
	}

	private pollClipboard(): void {
		const content = this.readLocalClipboard();
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
		this.sendClipboard(content);
	}

	private hashContent(content: string): string {
		return createHash('sha256').update(content).digest('hex');
	}
}
