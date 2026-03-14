// Network ports
export const WS_PORT = 8765;
export const VIDEO_PORT = 5004;

// Video defaults
export const DEFAULT_FPS = 60;
export const DEFAULT_WIDTH = 1920;
export const DEFAULT_HEIGHT = 1080;
export const DEFAULT_BITRATE = 6_000; // kbps
export const DEFAULT_CRF = 23;

// Clipboard
export const CLIPBOARD_POLL_MS = 100;

// Health monitoring
export const HEALTH_INTERVAL_MS = 5_000;
export const HEALTH_TIMEOUT_MS = 15_000;

// Input agent
export const INPUT_SOCKET_PATH = '/tmp/macstream-input.sock';
export const INPUT_AGENT_MAX_RESTARTS = 5;
export const INPUT_AGENT_RESTART_DELAY_MS = 2_000;

// Recovery monitoring
export const MEMORY_THRESHOLD_MB = 500;
export const MEMORY_CHECK_INTERVAL_MS = 30_000;

// Reconnection
export const MAX_RECONNECT_ATTEMPTS = 10;
export const RECONNECT_DELAY_MS = 1_000;
export const RECONNECT_BACKOFF_MULTIPLIER = 1.5;
export const RECONNECT_MAX_DELAY_MS = 30_000;

// Modifier key bitmask
export const MODIFIER_SHIFT = 1;
export const MODIFIER_CTRL = 2;
export const MODIFIER_ALT = 4;
export const MODIFIER_META = 8;
