import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { type H264CodecConfig, type H264Frame, TSDemuxer } from '../src/client/ts-demuxer.js';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH } from '../src/shared/constants.js';

const TS_PACKET_SIZE = 188;

function buildTsPacket(
	pid: number,
	payload: Buffer,
	options?: { pusi?: boolean; adaptationField?: Buffer },
): Buffer {
	const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
	const pusi = options?.pusi ?? false;
	const adaptationField = options?.adaptationField;

	packet[0] = 0x47;
	packet[1] = ((pusi ? 1 : 0) << 6) | ((pid >> 8) & 0x1f);
	packet[2] = pid & 0xff;

	let offset = 4;

	if (adaptationField) {
		packet[3] = 0x30;
		packet[offset] = adaptationField.length;
		offset += 1;
		adaptationField.copy(
			packet,
			offset,
			0,
			Math.min(adaptationField.length, TS_PACKET_SIZE - offset),
		);
		offset += adaptationField.length;
	} else if (payload.length < TS_PACKET_SIZE - 4) {
		const adaptationLength = TS_PACKET_SIZE - 5 - payload.length;
		packet[3] = 0x30;
		packet[offset] = adaptationLength;
		offset += 1 + adaptationLength;
	} else {
		packet[3] = 0x10;
	}

	if (offset >= TS_PACKET_SIZE) {
		return packet;
	}

	payload.copy(packet, offset, 0, Math.min(payload.length, TS_PACKET_SIZE - offset));
	return packet;
}

function buildPatPacket(pmtPid: number): Buffer {
	const section = Buffer.from([
		0x00,
		0xb0,
		0x0d,
		0x00,
		0x01,
		0xc1,
		0x00,
		0x00,
		0x00,
		0x01,
		0xe0 | ((pmtPid >> 8) & 0x1f),
		pmtPid & 0xff,
		0x00,
		0x00,
		0x00,
		0x00,
	]);

	const payload = Buffer.concat([Buffer.from([0x00]), section]);
	return buildTsPacket(0x0000, payload, { pusi: true });
}

function buildPmtPacket(pmtPid: number, videoPid: number): Buffer {
	const section = Buffer.from([
		0x02,
		0xb0,
		0x12,
		0x00,
		0x01,
		0xc1,
		0x00,
		0x00,
		0xe0,
		0x64,
		0xf0,
		0x00,
		0x1b,
		0xe0 | ((videoPid >> 8) & 0x1f),
		videoPid & 0xff,
		0xf0,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
	]);

	const payload = Buffer.concat([Buffer.from([0x00]), section]);
	return buildTsPacket(pmtPid, payload, { pusi: true });
}

function encodePts(pts90khz: number): Buffer {
	const pts = BigInt(pts90khz) & 0x1ffffffffn;
	const b0 = Number(0x20n | (((pts >> 30n) & 0x07n) << 1n) | 0x01n);
	const b1 = Number((pts >> 22n) & 0xffn);
	const b2 = Number((((pts >> 15n) & 0x7fn) << 1n) | 0x01n);
	const b3 = Number((pts >> 7n) & 0xffn);
	const b4 = Number(((pts & 0x7fn) << 1n) | 0x01n);
	return Buffer.from([b0, b1, b2, b3, b4]);
}

function buildPesHeader(pts90khz?: number): Buffer {
	if (typeof pts90khz === 'number') {
		const ptsBytes = encodePts(pts90khz);
		return Buffer.from([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x80, 0x05, ...ptsBytes]);
	}

	return Buffer.from([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x00, 0x00]);
}

function buildNalu(type: number, data: number[] = [0x11, 0x22, 0x33]): Buffer {
	return Buffer.from([0x00, 0x00, 0x00, 0x01, type & 0x1f, ...data]);
}

function buildVideoPesPacket(videoPid: number, payload: Buffer, pusi = true): Buffer {
	return buildTsPacket(videoPid, payload, { pusi });
}

describe('TSDemuxer', () => {
	it('constructor defaults (width/height)', () => {
		const demuxer = new TSDemuxer();
		const configs: H264CodecConfig[] = [];

		demuxer.on('config', (cfg: H264CodecConfig) => {
			configs.push(cfg);
		});

		const pmtPid = 0x100;
		const videoPid = 0x101;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const sps = buildNalu(7, [0x64, 0x00, 0x28]);
		const pps = buildNalu(8, [0xee, 0x06, 0xf2]);
		const idr = buildNalu(5, [0xaa]);
		const pes = Buffer.concat([buildPesHeader(), sps, pps, idr]);
		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		demuxer.flush();

		expect(configs).toHaveLength(1);
		expect(configs[0].width).toBe(DEFAULT_WIDTH);
		expect(configs[0].height).toBe(DEFAULT_HEIGHT);
	});

	it('PAT parsing finds PMT PID and enables stream parsing', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x120;
		const videoPid = 0x121;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const pes = Buffer.concat([buildPesHeader(), buildNalu(1)]);
		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		demuxer.flush();

		expect(frames).toHaveLength(1);
	});

	it('PMT parsing finds video PID for stream type 0x1B', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x200;
		const videoPid = 0x2ab;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const pes = Buffer.concat([buildPesHeader(), buildNalu(1, [0x99])]);
		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		demuxer.flush();

		expect(frames).toHaveLength(1);
		expect(frames[0].data.length).toBeGreaterThan(0);
	});

	it('PES assembly emits frame with correct data across continuation packets', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x130;
		const videoPid = 0x131;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const naluA = buildNalu(1, [0x10, 0x20, 0x30]);
		const naluB = buildNalu(1, [0x40, 0x50, 0x60]);
		const payload = Buffer.concat([buildPesHeader(), naluA, naluB]);

		const firstChunk = payload.subarray(0, 120);
		const secondChunk = payload.subarray(120);

		demuxer.push(buildVideoPesPacket(videoPid, firstChunk, true));
		demuxer.push(buildVideoPesPacket(videoPid, secondChunk, false));
		demuxer.flush();

		expect(frames).toHaveLength(1);
		expect(Buffer.from(frames[0].data)).toEqual(Buffer.concat([naluA, naluB]));
	});

	it('PTS extraction converts 90kHz ticks to microseconds', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x140;
		const videoPid = 0x141;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const pts = 90_000;
		const pes = Buffer.concat([buildPesHeader(pts), buildNalu(1)]);
		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		demuxer.flush();

		expect(frames).toHaveLength(1);
		expect(frames[0].pts).toBe(1_000_000);
	});

	it('keyframe detection sets isKeyframe for IDR NALU type 5', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x150;
		const videoPid = 0x151;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const pes = Buffer.concat([buildPesHeader(), buildNalu(5)]);
		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		demuxer.flush();

		expect(frames).toHaveLength(1);
		expect(frames[0].isKeyframe).toBe(true);
	});

	it('non-keyframe frame sets isKeyframe false for slice type 1', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x160;
		const videoPid = 0x161;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const pes = Buffer.concat([buildPesHeader(), buildNalu(1)]);
		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		demuxer.flush();

		expect(frames).toHaveLength(1);
		expect(frames[0].isKeyframe).toBe(false);
	});

	it('SPS + PPS detection emits config with codec string', () => {
		const demuxer = new TSDemuxer(1280, 720);
		const configs: H264CodecConfig[] = [];

		demuxer.on('config', (config: H264CodecConfig) => {
			configs.push(config);
		});

		const pmtPid = 0x170;
		const videoPid = 0x171;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const spsPayload = [0x64, 0x00, 0x28, 0xde];
		const ppsPayload = [0xee, 0x06, 0xf2];
		const pes = Buffer.concat([
			buildPesHeader(),
			buildNalu(7, spsPayload),
			buildNalu(8, ppsPayload),
			buildNalu(5),
		]);

		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		demuxer.flush();

		expect(configs).toHaveLength(1);
		expect(configs[0].codec).toBe('avc1.640028');
		expect(configs[0].width).toBe(1280);
		expect(configs[0].height).toBe(720);
		expect(Array.from(configs[0].sps)).toEqual([0x07, ...spsPayload]);
		expect(Array.from(configs[0].pps)).toEqual([0x08, ...ppsPayload]);
	});

	it('config event is emitted only once', () => {
		const demuxer = new TSDemuxer();
		let configCount = 0;

		demuxer.on('config', () => {
			configCount++;
		});

		const pmtPid = 0x180;
		const videoPid = 0x181;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const frameA = Buffer.concat([
			buildPesHeader(),
			buildNalu(7, [0x64, 0x00, 0x28]),
			buildNalu(8),
		]);
		const frameB = Buffer.concat([
			buildPesHeader(),
			buildNalu(7, [0x64, 0x00, 0x28]),
			buildNalu(8),
		]);

		demuxer.push(buildVideoPesPacket(videoPid, frameA, true));
		demuxer.push(buildVideoPesPacket(videoPid, frameB, true));
		demuxer.flush();

		expect(configCount).toBe(1);
	});

	it('multiple frames in sequence are emitted on PUSI boundaries', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x190;
		const videoPid = 0x191;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const first = Buffer.concat([buildPesHeader(45_000), buildNalu(1, [0x01])]);
		const second = Buffer.concat([buildPesHeader(90_000), buildNalu(5, [0x02])]);

		demuxer.push(buildVideoPesPacket(videoPid, first, true));
		demuxer.push(buildVideoPesPacket(videoPid, second, true));
		demuxer.flush();

		expect(frames).toHaveLength(2);
		expect(frames[0].pts).toBe(500_000);
		expect(frames[1].pts).toBe(1_000_000);
		expect(frames[1].isKeyframe).toBe(true);
	});

	it('flush() emits pending frame', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x1a0;
		const videoPid = 0x1a1;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));

		const pes = Buffer.concat([buildPesHeader(), buildNalu(1)]);
		demuxer.push(buildVideoPesPacket(videoPid, pes, true));
		expect(frames).toHaveLength(0);

		demuxer.flush();
		expect(frames).toHaveLength(1);
	});

	it('reset() clears parser state and allows re-parsing', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x1b0;
		const videoPid = 0x1b1;
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));
		demuxer.push(
			buildVideoPesPacket(videoPid, Buffer.concat([buildPesHeader(), buildNalu(1)]), true),
		);
		demuxer.flush();

		demuxer.reset();
		demuxer.push(buildPatPacket(pmtPid));
		demuxer.push(buildPmtPacket(pmtPid, videoPid));
		demuxer.push(
			buildVideoPesPacket(videoPid, Buffer.concat([buildPesHeader(), buildNalu(5)]), true),
		);
		demuxer.flush();

		expect(frames).toHaveLength(2);
		expect(frames[1].isKeyframe).toBe(true);
	});

	it('resyncs on corrupted bytes and continues parsing at next sync byte', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		const pmtPid = 0x1c0;
		const videoPid = 0x1c1;
		const validPackets = Buffer.concat([
			buildPatPacket(pmtPid),
			buildPmtPacket(pmtPid, videoPid),
			buildVideoPesPacket(videoPid, Buffer.concat([buildPesHeader(), buildNalu(1)]), true),
		]);

		const corruptedPrefix = Buffer.from([0x99, 0x88, 0x77, 0x66, 0x55]);
		demuxer.push(Buffer.concat([corruptedPrefix, validPackets]));
		demuxer.flush();

		expect(frames).toHaveLength(1);
	});

	it('handles empty and short packets gracefully', () => {
		const demuxer = new TSDemuxer();
		const frames: H264Frame[] = [];

		demuxer.on('frame', (frame: H264Frame) => {
			frames.push(frame);
		});

		demuxer.push(Buffer.alloc(0));
		demuxer.push(Buffer.from([0x47, 0x00, 0x10]));
		demuxer.flush();

		expect(frames).toHaveLength(0);
	});
});
