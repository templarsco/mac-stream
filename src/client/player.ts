interface PlayerConfig {
	codec: string;
	width: number;
	height: number;
}

interface PlayerStats {
	fps: number;
	latency: number;
	droppedFrames: number;
}

export class VideoPlayer {
	private decoder: VideoDecoder | null = null;
	private readonly ctx: CanvasRenderingContext2D;
	private configured = false;

	private frameCount = 0;
	private lastStatTime = performance.now();
	private currentFps = 0;
	private droppedFrames = 0;
	private hasReceivedKeyframe = false;

	constructor(canvas: HTMLCanvasElement) {
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('Failed to get 2D canvas context');
		}

		this.ctx = context;
	}

	configure(config: PlayerConfig): void {
		this.destroyDecoder();

		this.decoder = new VideoDecoder({
			output: (frame: VideoFrame) => {
				this.ctx.drawImage(frame, 0, 0);
				frame.close();
				this.frameCount++;
			},
			error: () => {
				this.droppedFrames++;
			},
		});

		this.decoder.configure({
			codec: config.codec,
			codedWidth: config.width,
			codedHeight: config.height,
		});

		const canvas = this.ctx.canvas;
		canvas.width = config.width;
		canvas.height = config.height;

		this.configured = true;
		this.hasReceivedKeyframe = false;
	}

	decode(data: Uint8Array, timestamp: number, isKeyframe: boolean): void {
		if (!this.decoder || !this.configured || this.decoder.state !== 'configured') {
			return;
		}

		if (!this.hasReceivedKeyframe && !isKeyframe) {
			return;
		}

		if (isKeyframe) {
			this.hasReceivedKeyframe = true;
		}

		if (!this.hasReceivedKeyframe) {
			return;
		}

		try {
			const chunk = new EncodedVideoChunk({
				type: isKeyframe ? 'key' : 'delta',
				timestamp,
				data,
			});

			this.decoder.decode(chunk);
		} catch {
			this.droppedFrames++;
		}
	}

	getStats(): PlayerStats {
		const now = performance.now();
		const elapsedMs = now - this.lastStatTime;

		if (elapsedMs > 0) {
			this.currentFps = Math.round((this.frameCount / elapsedMs) * 1000);
		}

		this.frameCount = 0;
		this.lastStatTime = now;

		return {
			fps: this.currentFps,
			latency: 0,
			droppedFrames: this.droppedFrames,
		};
	}

	destroy(): void {
		this.destroyDecoder();
		this.configured = false;
		this.frameCount = 0;
		this.currentFps = 0;
		this.droppedFrames = 0;
		this.hasReceivedKeyframe = false;
		this.lastStatTime = performance.now();
	}

	private destroyDecoder(): void {
		if (this.decoder) {
			if (this.decoder.state !== 'closed') {
				this.decoder.close();
			}
			this.decoder = null;
		}
	}
}
