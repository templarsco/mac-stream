import { InputCapture } from './input.js';
import { VideoPlayer } from './player.js';
import type { ConnectionStatus, MacStreamAPI } from './types.js';

declare global {
	interface Window {
		macstream: MacStreamAPI;
	}
}

const api = window.macstream;

// --- DOM Elements ---

function requireElement<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) {
		throw new Error(`Required element #${id} not found`);
	}
	return el as T;
}

export const canvas = requireElement<HTMLCanvasElement>('stream-canvas');
const connectBtn = requireElement<HTMLButtonElement>('connect-btn');
const disconnectBtn = requireElement<HTMLButtonElement>('disconnect-btn');
const serverIpInput = requireElement<HTMLInputElement>('server-ip');
const statusEl = requireElement<HTMLSpanElement>('connection-status');
const fpsEl = requireElement<HTMLSpanElement>('fps-counter');
const latencyEl = requireElement<HTMLSpanElement>('latency-counter');
const placeholderEl = requireElement<HTMLDivElement>('placeholder');
const player = new VideoPlayer(canvas);
const inputCapture = new InputCapture(canvas, (event) => api.sendInput(event));

inputCapture.onClipboardCopy = () => {
	// Ctrl+C flow is handled server-side after Cmd+C reaches macOS.
};

inputCapture.onClipboardPaste = () => {
	void (async () => {
		try {
			const text = await navigator.clipboard.readText();
			api.sendClipboard(text);
		} catch (error) {
			console.error('[MacStream] Failed to read local clipboard:', error);
		}
	})();
};

// --- Connection UI ---

connectBtn.addEventListener('click', () => {
	const ip = serverIpInput.value.trim();
	if (ip) {
		void api.connect(ip);
	}
});

disconnectBtn.addEventListener('click', () => {
	void api.disconnect();
});

serverIpInput.addEventListener('keydown', (e: KeyboardEvent) => {
	if (e.key === 'Enter') {
		connectBtn.click();
	}
});

// --- Event Handlers ---

api.onConnectionStatus((status: ConnectionStatus) => {
	statusEl.textContent = status;
	statusEl.className = `status-${status}`;

	const isConnected = status === 'connected' || status === 'streaming';
	const isConnecting = status === 'connecting';

	if (isConnected) {
		inputCapture.enable();
	}

	if (status === 'disconnected' || status === 'error') {
		inputCapture.disable();
	}

	connectBtn.disabled = isConnected || isConnecting;
	disconnectBtn.disabled = status === 'disconnected';
	serverIpInput.disabled = isConnected || isConnecting;

	placeholderEl.style.display = isConnected ? 'none' : 'flex';
});

api.onVideoConfig((config) => {
	player.configure(config);
});

api.onVideoFrame((data, timestamp, isKeyframe) => {
	player.decode(data, timestamp, isKeyframe);
});

api.onClipboardUpdate((content) => {
	void navigator.clipboard.writeText(content).catch((error) => {
		console.error('[MacStream] Failed to write local clipboard:', error);
	});
});

setInterval(() => {
	const stats = player.getStats();
	fpsEl.textContent = `${String(stats.fps)} FPS`;
	latencyEl.textContent = `${String(stats.latency)} ms`;
}, 1000);

console.log('[MacStream] Renderer initialized');
