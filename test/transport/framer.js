import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
	DestType,
	HeaderType,
	Packet,
	PacketType,
} from "../../src/core/packet.js";
import {
	createRNSFramerStream,
	createRNSUnframerStream,
	hdlcEscape,
	hdlcUnescape,
} from "../../src/transport/framer.js";

// --- 1. Helper Utility ---

/**
 * Feeds an array of Uint8Array chunks into the framer and collects the output.
 * This is actually for testing the UNFRAMER.
 */
async function runUnframerTest(chunks) {
	const unframer = createRNSUnframerStream(Packet);
	const writer = unframer.writable.getWriter();
	const reader = unframer.readable.getReader();
	const results = [];

	const pump = async () => {
		for (const chunk of chunks) {
			await writer.write(chunk);
		}
		await writer.close();
	};

	const consume = async () => {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			results.push(value);
		}
	};

	await Promise.all([pump(), consume()]);
	return results;
}

/**
 * Feeds an array of Packet objects into the framer and collects the output.
 */
async function runFramerTest(packets) {
	const framer = createRNSFramerStream(Packet);
	const writer = framer.writable.getWriter();
	const reader = framer.readable.getReader();
	const results = [];

	const pump = async () => {
		for (const packet of packets) {
			await writer.write(packet);
		}
		await writer.close();
	};

	const consume = async () => {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			results.push(value);
		}
	};

	await Promise.all([pump(), consume()]);
	return results;
}

// --- 2. The Test Suite ---

describe("HDLC Utilities", () => {
	test("hdlcEscape and hdlcUnescape should be inverses", () => {
		const data = new Uint8Array([0x7e, 0x01, 0x7d, 0x02, 0x00, 0xff]);
		const escaped = hdlcEscape(data);
		const unescaped = hdlcUnescape(escaped);
		assert.deepEqual(data, unescaped);
	});
});

describe("RNS Framer TransformStream", () => {
	test("Perfect alignment: 1 packet = 1 frame", async () => {
		const packet = new Packet({
			headerType: HeaderType.HEADER_1,
			hops: 1,
			transportType: 0,
			destinationType: DestType.SINGLE,
			packetType: PacketType.DATA,
			contextFlag: false,
			destinationHash: new Uint8Array(16),
			payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
		});

		const results = await runFramerTest([packet]);

		assert.equal(results.length, 1);
		const serialized = packet.serialize();
		const escaped = hdlcEscape(serialized);
		const expectedFrame = new Uint8Array(escaped.length + 2);
		expectedFrame[0] = 0x7e;
		expectedFrame.set(escaped, 1);
		expectedFrame[expectedFrame.length - 1] = 0x7e;

		assert.deepEqual(results[0], expectedFrame);
	});
});

describe("RNS Unframer TransformStream", () => {
	test("Perfect alignment: 1 frame = 1 packet", async () => {
		const packet = new Packet({
			headerType: HeaderType.HEADER_1,
			hops: 1,
			transportType: 0,
			destinationType: DestType.SINGLE,
			packetType: PacketType.DATA,
			contextFlag: false,
			destinationHash: new Uint8Array(16),
			payload: new Uint8Array([0xaa, 0xbb]),
		});

		const serialized = packet.serialize();
		const escaped = hdlcEscape(serialized);
		const frame = new Uint8Array(escaped.length + 2);
		frame[0] = 0x7e;
		frame.set(escaped, 1);
		frame[frame.length - 1] = 0x7e;

		const results = await runUnframerTest([frame]);

		assert.equal(results.length, 1);
		assert.ok(results[0] instanceof Packet);
		assert.equal(results[0].packetType, PacketType.DATA);
		assert.deepEqual(results[0].payload, packet.payload);
	});

	test("Fragmentation: 1 frame split across multiple chunks", async () => {
		const packet = new Packet({
			headerType: HeaderType.HEADER_1,
			hops: 1,
			transportType: 0,
			destinationType: DestType.SINGLE,
			packetType: PacketType.DATA,
			contextFlag: false,
			destinationHash: new Uint8Array(16),
			payload: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
		});

		const serialized = packet.serialize();
		const escaped = hdlcEscape(serialized);
		const frame = new Uint8Array(escaped.length + 2);
		frame[0] = 0x7e;
		frame.set(escaped, 1);
		frame[frame.length - 1] = 0x7e;

		// Split frame into 3 chunks
		const chunk1 = frame.slice(0, 3);
		const chunk2 = frame.slice(3, 6);
		const chunk3 = frame.slice(6);

		const results = await runUnframerTest([chunk1, chunk2, chunk3]);

		assert.equal(results.length, 1);
		assert.deepEqual(results[0].payload, packet.payload);
	});

	test("Coalescing: Multiple frames in one chunk", async () => {
		const p1 = new Packet({
			headerType: HeaderType.HEADER_1,
			hops: 1,
			transportType: 0,
			destinationType: DestType.SINGLE,
			packetType: PacketType.DATA,
			contextFlag: false,
			destinationHash: new Uint8Array(16),
			payload: new Uint8Array([0x01]),
		});
		const p2 = new Packet({
			headerType: HeaderType.HEADER_1,
			hops: 2,
			transportType: 0,
			destinationType: DestType.SINGLE,
			packetType: PacketType.DATA,
			contextFlag: false,
			destinationHash: new Uint8Array(16),
			payload: new Uint8Array([0x02]),
		});

		const f1 = new Uint8Array(hdlcEscape(p1.serialize()).length + 2);
		f1[0] = 0x7e;
		f1.set(hdlcEscape(p1.serialize()), 1);
		f1[f1.length - 1] = 0x7e;

		const f2 = new Uint8Array(hdlcEscape(p2.serialize()).length + 2);
		f2[0] = 0x7e;
		f2.set(hdlcEscape(p2.serialize()), 1);
		f2[f2.length - 1] = 0x7e;

		const combined = new Uint8Array([...f1, ...f2]);

		const results = await runUnframerTest([combined]);

		assert.equal(results.length, 2);
		assert.deepEqual(results[0].payload, p1.payload);
		assert.deepEqual(results[1].payload, p2.payload);
	});
});
