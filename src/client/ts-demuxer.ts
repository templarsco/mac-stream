import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH } from '../shared/constants.js';

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const PAT_PID = 0x0000;
const H264_STREAM_TYPE = 0x1b;

export interface H264Frame {
	data: Uint8Array;
	pts: number;
	isKeyframe: boolean;
}

export interface H264CodecConfig {
	codec: string;
	width: number;
	height: number;
	sps: Uint8Array;
	pps: Uint8Array;
}

interface StartCodeMatch {
	index: number;
	length: number;
}

export class TSDemuxer extends EventEmitter {
	private readonly width: number;
	private readonly height: number;

	private streamBuffer = Buffer.alloc(0);
	private pmtPid: number | null = null;
	private videoPid: number | null = null;

	private pesChunks: Buffer[] = [];
	private pesPtsUs = 0;

	private sps: Uint8Array | null = null;
	private pps: Uint8Array | null = null;
	private configEmitted = false;

	constructor(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
		super();
		this.width = width;
		this.height = height;
	}

	push(data: Buffer): void {
		if (data.length === 0) {
			return;
		}

		this.streamBuffer =
			this.streamBuffer.length === 0 ? Buffer.from(data) : Buffer.concat([this.streamBuffer, data]);

		while (this.streamBuffer.length >= TS_PACKET_SIZE) {
			if (this.streamBuffer[0] !== TS_SYNC_BYTE) {
				const syncIndex = this.streamBuffer.indexOf(TS_SYNC_BYTE, 1);
				if (syncIndex === -1) {
					this.streamBuffer = Buffer.alloc(0);
					return;
				}
				this.streamBuffer = this.streamBuffer.subarray(syncIndex);
				if (this.streamBuffer.length < TS_PACKET_SIZE) {
					return;
				}
			}

			const packet = this.streamBuffer.subarray(0, TS_PACKET_SIZE);
			this.streamBuffer = this.streamBuffer.subarray(TS_PACKET_SIZE);
			this.parsePacket(packet);
		}
	}

	flush(): void {
		this.flushPes();
	}

	reset(): void {
		this.streamBuffer = Buffer.alloc(0);
		this.pmtPid = null;
		this.videoPid = null;
		this.pesChunks = [];
		this.pesPtsUs = 0;
		this.sps = null;
		this.pps = null;
		this.configEmitted = false;
	}

	private parsePacket(packet: Buffer): void {
		if (packet.length !== TS_PACKET_SIZE || packet[0] !== TS_SYNC_BYTE) {
			return;
		}

		const payloadUnitStart = (packet[1] & 0x40) !== 0;
		const pid = ((packet[1] & 0x1f) << 8) | packet[2];
		const adaptationFieldControl = (packet[3] >> 4) & 0x03;
		const hasAdaptation = (adaptationFieldControl & 0x02) !== 0;
		const hasPayload = (adaptationFieldControl & 0x01) !== 0;

		let offset = 4;
		if (hasAdaptation) {
			const adaptationLength = packet[offset] ?? 0;
			offset += 1 + adaptationLength;
		}

		if (!hasPayload || offset >= TS_PACKET_SIZE) {
			return;
		}

		const payload = packet.subarray(offset);

		if (pid === PAT_PID) {
			this.parsePat(payload, payloadUnitStart);
			return;
		}

		if (this.pmtPid !== null && pid === this.pmtPid) {
			this.parsePmt(payload, payloadUnitStart);
			return;
		}

		if (this.videoPid !== null && pid === this.videoPid) {
			this.parseVideoPayload(payload, payloadUnitStart);
		}
	}

	private parsePat(payload: Buffer, payloadUnitStart: boolean): void {
		const section = this.extractPsiSection(payload, payloadUnitStart);
		if (!section || section.length < 12 || section[0] !== 0x00) {
			return;
		}

		const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
		const sectionEnd = 3 + sectionLength;
		if (sectionEnd > section.length) {
			return;
		}

		const programInfoStart = 8;
		const programInfoEnd = sectionEnd - 4;
		for (let offset = programInfoStart; offset + 4 <= programInfoEnd; offset += 4) {
			const programNumber = (section[offset] << 8) | section[offset + 1];
			if (programNumber === 0) {
				continue;
			}
			this.pmtPid = ((section[offset + 2] & 0x1f) << 8) | section[offset + 3];
			return;
		}
	}

	private parsePmt(payload: Buffer, payloadUnitStart: boolean): void {
		const section = this.extractPsiSection(payload, payloadUnitStart);
		if (!section || section.length < 17 || section[0] !== 0x02) {
			return;
		}

		const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
		const sectionEnd = 3 + sectionLength;
		if (sectionEnd > section.length) {
			return;
		}

		const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
		let offset = 12 + programInfoLength;
		const streamsEnd = sectionEnd - 4;

		while (offset + 5 <= streamsEnd) {
			const streamType = section[offset];
			const elementaryPid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2];
			const esInfoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];

			if (streamType === H264_STREAM_TYPE) {
				this.videoPid = elementaryPid;
				return;
			}

			offset += 5 + esInfoLength;
		}
	}

	private parseVideoPayload(payload: Buffer, payloadUnitStart: boolean): void {
		if (payloadUnitStart) {
			this.flushPes();
			this.startPes(payload);
			return;
		}

		if (this.pesChunks.length === 0) {
			return;
		}

		this.pesChunks.push(Buffer.from(payload));
	}

	private startPes(payload: Buffer): void {
		this.pesChunks = [];
		this.pesPtsUs = 0;

		if (payload.length < 9) {
			this.pesChunks.push(Buffer.from(payload));
			return;
		}

		if (payload[0] !== 0x00 || payload[1] !== 0x00 || payload[2] !== 0x01) {
			this.pesChunks.push(Buffer.from(payload));
			return;
		}

		const ptsDtsFlags = (payload[7] >> 6) & 0x03;
		const headerDataLength = payload[8];

		if (ptsDtsFlags >= 0x02 && payload.length >= 14) {
			const pts = this.parsePts(payload.subarray(9, 14));
			this.pesPtsUs = Math.floor((pts / 90_000) * 1_000_000);
		}

		const dataOffset = 9 + headerDataLength;
		if (dataOffset < payload.length) {
			this.pesChunks.push(Buffer.from(payload.subarray(dataOffset)));
		}
	}

	private flushPes(): void {
		if (this.pesChunks.length === 0) {
			return;
		}

		const data = Buffer.concat(this.pesChunks);
		this.pesChunks = [];

		if (data.length === 0) {
			return;
		}

		const isKeyframe = this.scanNalus(data);
		const frame: H264Frame = {
			data: new Uint8Array(data),
			pts: this.pesPtsUs,
			isKeyframe,
		};
		this.emit('frame', frame);
	}

	private extractPsiSection(payload: Buffer, payloadUnitStart: boolean): Uint8Array | null {
		if (payload.length === 0) {
			return null;
		}

		let offset = 0;
		if (payloadUnitStart) {
			const pointerField = payload[0] ?? 0;
			offset = 1 + pointerField;
		}

		if (offset >= payload.length) {
			return null;
		}

		return payload.subarray(offset);
	}

	private parsePts(ptsBytes: Uint8Array): number {
		if (ptsBytes.length < 5) {
			return 0;
		}

		return (
			(ptsBytes[0] & 0x0e) * 536_870_912 +
			ptsBytes[1] * 4_194_304 +
			(ptsBytes[2] & 0xfe) * 16_384 +
			ptsBytes[3] * 128 +
			(ptsBytes[4] & 0xfe) / 2
		);
	}

	private scanNalus(data: Uint8Array): boolean {
		let isKeyframe = false;
		let current = this.findStartCode(data, 0);

		while (current) {
			const next = this.findStartCode(data, current.index + current.length);
			const naluStart = current.index + current.length;
			const naluEnd = next ? next.index : data.length;

			if (naluStart < naluEnd) {
				const nalu = data.subarray(naluStart, naluEnd);
				const naluType = nalu[0] & 0x1f;

				if (naluType === 5) {
					isKeyframe = true;
				}

				if (naluType === 7) {
					this.sps = new Uint8Array(nalu);
				}

				if (naluType === 8) {
					this.pps = new Uint8Array(nalu);
				}

				this.maybeEmitConfig();
			}

			current = next;
		}

		return isKeyframe;
	}

	private findStartCode(data: Uint8Array, from: number): StartCodeMatch | null {
		for (let i = from; i + 3 < data.length; i++) {
			if (data[i] !== 0x00 || data[i + 1] !== 0x00) {
				continue;
			}

			if (data[i + 2] === 0x01) {
				return { index: i, length: 3 };
			}

			if (data[i + 2] === 0x00 && data[i + 3] === 0x01) {
				return { index: i, length: 4 };
			}
		}

		return null;
	}

	private maybeEmitConfig(): void {
		if (this.configEmitted || !this.sps || !this.pps) {
			return;
		}

		const codec = this.buildCodecString(this.sps);
		this.configEmitted = true;

		const config: H264CodecConfig = {
			codec,
			width: this.width,
			height: this.height,
			sps: new Uint8Array(this.sps),
			pps: new Uint8Array(this.pps),
		};

		this.emit('config', config);
	}

	private buildCodecString(sps: Uint8Array): string {
		if (sps.length < 4) {
			return 'avc1.000000';
		}

		const profile = sps[1].toString(16).padStart(2, '0');
		const constraints = sps[2].toString(16).padStart(2, '0');
		const level = sps[3].toString(16).padStart(2, '0');
		return `avc1.${profile}${constraints}${level}`;
	}
}
