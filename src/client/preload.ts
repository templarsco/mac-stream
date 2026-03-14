import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';
import type { CleanupFn, MacStreamAPI } from './types.js';

function onChannel<T>(channel: string, callback: (data: T) => void): CleanupFn {
	const handler = (_event: IpcRendererEvent, data: T): void => {
		callback(data);
	};
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.removeListener(channel, handler);
	};
}

const api: MacStreamAPI = {
	// Connection (renderer → main)
	connect: (serverIp: string, wsPort?: number, videoPort?: number) =>
		ipcRenderer.invoke('macstream:connect', serverIp, wsPort, videoPort) as Promise<void>,

	disconnect: () => ipcRenderer.invoke('macstream:disconnect') as Promise<void>,

	// Input (renderer → main)
	sendInput: (event: Record<string, unknown>) => {
		ipcRenderer.send('macstream:input', event);
	},

	// Clipboard (renderer → main)
	sendClipboard: (content: string) => {
		ipcRenderer.send('macstream:clipboard', content);
	},

	// Video (main → renderer)
	onVideoFrame: (callback) => {
		const handler = (
			_event: IpcRendererEvent,
			data: Uint8Array,
			timestamp: number,
			isKeyframe: boolean,
		): void => {
			callback(data, timestamp, isKeyframe);
		};
		ipcRenderer.on('macstream:video-frame', handler);
		return () => {
			ipcRenderer.removeListener('macstream:video-frame', handler);
		};
	},

	onVideoConfig: (callback) => onChannel('macstream:video-config', callback),

	// Connection status (main → renderer)
	onConnectionStatus: (callback) => onChannel('macstream:connection-status', callback),

	// Clipboard (main → renderer)
	onClipboardUpdate: (callback) => onChannel('macstream:clipboard-update', callback),

	// Stats (main → renderer)
	onStats: (callback) => onChannel('macstream:stats', callback),
};

contextBridge.exposeInMainWorld('macstream', api);
