/**
 * MacStream Client API — exposed to renderer via contextBridge.
 *
 * This interface defines the IPC contract between Electron main process
 * and the renderer. Used by both preload.ts (implementation) and
 * renderer.ts (consumption via window.macstream).
 */

export type CleanupFn = () => void;

export interface MacStreamAPI {
	// Connection (renderer → main)
	connect(serverIp: string, wsPort?: number, videoPort?: number): Promise<void>;
	disconnect(): Promise<void>;

	// Input (renderer → main)
	sendInput(event: Record<string, unknown>): void;

	// Clipboard (renderer → main)
	sendClipboard(content: string): void;

	// Video (main → renderer)
	onVideoFrame(
		callback: (data: Uint8Array, timestamp: number, isKeyframe: boolean) => void,
	): CleanupFn;
	onVideoConfig(
		callback: (config: { codec: string; width: number; height: number }) => void,
	): CleanupFn;

	// Connection status (main → renderer)
	onConnectionStatus(callback: (status: ConnectionStatus) => void): CleanupFn;

	// Clipboard (main → renderer)
	onClipboardUpdate(callback: (content: string) => void): CleanupFn;

	// Stats (main → renderer)
	onStats(callback: (stats: StreamStats) => void): CleanupFn;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'streaming' | 'error';

export interface StreamStats {
	fps: number;
	bitrate: number;
	latency: number;
	droppedFrames: number;
}
