import path from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import {
	type ClipboardUpdateMessage,
	type InputEventData,
	type InputEventMessage,
	type ProtocolMessage,
	createMessage,
} from '../shared/protocol.js';
import { ClipboardSync } from './clipboard.js';
import { ConnectionManager } from './connection.js';

// CJS globals — available at runtime in the tsup CJS bundle
declare const __dirname: string;

let mainWindow: BrowserWindow | null = null;
let clipboardSync: ClipboardSync | null = null;

const connectionManager = new ConnectionManager({
	onStatus: (status) => {
		mainWindow?.webContents.send('macstream:connection-status', status);
	},
	onVideoFrame: (data, pts, isKeyframe) => {
		mainWindow?.webContents.send('macstream:video-frame', data, pts, isKeyframe);
	},
	onVideoConfig: (config) => {
		mainWindow?.webContents.send('macstream:video-config', config);
	},
	onMessage: (message: ProtocolMessage) => {
		if (message.type !== 'clipboard_update' || message.format !== 'text') {
			return;
		}

		clipboardSync?.writeRemoteContent(message.content);
		mainWindow?.webContents.send('macstream:clipboard-update', message.content);
	},
});

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1920,
		height: 1080,
		title: 'MacStream',
		backgroundColor: '#0a0a0a',
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	mainWindow.loadFile(path.join(__dirname, 'index.html'));

	// Open DevTools for debugging (detached so it doesn't resize the stream view)
	mainWindow.webContents.openDevTools({ mode: 'detach' });

	clipboardSync = new ClipboardSync({
		sendClipboard: (content: string) => {
			sendClipboardToServer(content);
		},
	});
	clipboardSync.start();

	mainWindow.on('closed', () => {
		clipboardSync?.dispose();
		clipboardSync = null;
		connectionManager.dispose();

		mainWindow = null;
	});
}

function sendClipboardToServer(content: string): void {
	const message = createMessage<ClipboardUpdateMessage>('clipboard_update', {
		content,
		format: 'text',
	});
	connectionManager.sendMessage(message);
}

function setupIpcHandlers(): void {
	ipcMain.handle(
		'macstream:connect',
		async (_event, serverIp: string, wsPort?: number, videoPort?: number) => {
			connectionManager.connect(serverIp, wsPort, videoPort);

			console.log(
				`[MacStream] Connect: ${serverIp}:${String(wsPort ?? 8765)}, video: ${String(videoPort ?? 5004)}`,
			);
		},
	);

	ipcMain.handle('macstream:disconnect', async () => {
		connectionManager.disconnect();

		console.log('[MacStream] Disconnect');
	});

	ipcMain.on('macstream:input', (_event, inputData: InputEventData) => {
		connectionManager.sendMessage(
			createMessage<InputEventMessage>('input_event', {
				event: inputData,
			}),
		);
	});

	ipcMain.on('macstream:clipboard', (_event, content: string) => {
		sendClipboardToServer(content);
	});
}

app.whenReady().then(() => {
	createWindow();
	setupIpcHandlers();
});

app.on('window-all-closed', () => {
	app.quit();
});
