# MacStream

High-performance screen streaming from macOS to Windows over Tailscale VPN.

Replaces RustDesk for GitHub Actions Mac remote access with:
- **60 FPS** stable at 1080p (x264 ultrafast software encoding)
- **< 50ms latency** over Tailscale LAN
- **Bidirectional clipboard** (Ctrl+C/V)
- **Full input forwarding** (keyboard + mouse)
- **Auto-recovery** from any component crash

## Architecture

```
macOS Server                         Windows Client
┌──────────────────┐                ┌──────────────────┐
│ FFmpeg (capture   │───UDP:5004───▶│ Video Player     │
│ + x264 encode)   │                │ (mpegts.js)      │
│                  │                │                  │
│ Node.js (control)│◀──WS:8765────▶│ Input + Clipboard│
│                  │                │                  │
│ Swift (input     │                │                  │
│ agent)           │                │                  │
└──────────────────┘                └──────────────────┘
         └────── Tailscale VPN ──────┘
```

## Quick Start

### Server (macOS)
```bash
npm install
npm run build:server
node dist/server/index.js --client-ip <tailscale-ip>
```

### Client (Windows)
```bash
npm run build:client
npm run client -- --server-ip <tailscale-ip>
```

## Development

```bash
npm install          # Install dependencies
npm run dev          # Start server in dev mode
npm test             # Run tests
npm run typecheck    # Type checking
npm run lint         # Lint
```
