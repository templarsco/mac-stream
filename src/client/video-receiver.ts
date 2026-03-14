import dgram, { type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, VIDEO_PORT } from '../shared/constants.js';
import { type H264CodecConfig, type H264Frame, TSDemuxer } from './ts-demuxer.js';

export class VideoReceiver extends EventEmitter {
	private socket: Socket | null = null;
	private demuxer: TSDemuxer;
	private readonly port: number;

	constructor(port = VIDEO_PORT, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
		super();
		this.port = port;
		this.demuxer = new TSDemuxer(width, height);
		this.bindDemuxerEvents();
	}

	start(): void {
		if (this.socket) {
			return;
		}

		const socket = dgram.createSocket('udp4');
		this.socket = socket;

		socket.on('message', (message: Buffer) => {
			this.demuxer.push(message);
		});

		socket.on('listening', () => {
			this.emit('listening', this.port);
		});

		socket.on('error', (error: Error) => {
			this.emit('error', error);
		});

		socket.bind(this.port);
	}

	stop(): void {
		if (this.socket) {
			this.socket.close();
			this.socket = null;
		}

		this.demuxer.flush();
		this.demuxer.reset();
	}

	getPort(): number {
		return this.port;
	}

	private bindDemuxerEvents(): void {
		this.demuxer.on('frame', (frame: H264Frame) => {
			this.emit('frame', frame);
		});

		this.demuxer.on('config', (config: H264CodecConfig) => {
			this.emit('config', config);
		});
	}
}
