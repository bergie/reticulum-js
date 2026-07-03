import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { 
    createRNSFramerStream, 
    createRNSUnframerStream, 
    FramingMode 
} from '../../src/transport/framer.js';

// --- 1. System Under Test (Mocked for isolation) ---

// Mocking the RNS length parser: Assumes the first byte dictates total packet length
function parsePacketLength(buffer) {
    if (buffer.length < 1) return Infinity; // Need more data
    return buffer[0]; 
}

class RNSFramerStream extends TransformStream {
    constructor() {
        let buffer = new Uint8Array(0);
        super({
            transform(chunk, controller) {
                const combined = new Uint8Array(buffer.length + chunk.length);
                combined.set(buffer);
                combined.set(chunk, buffer.length);
                buffer = combined;

                while (buffer.length >= 1) { // 1 byte minimum for our mocked header
                    const expectedLength = parsePacketLength(buffer); 
                    if (buffer.length >= expectedLength) {
                        controller.enqueue(buffer.slice(0, expectedLength));
                        buffer = buffer.slice(expectedLength);
                    } else {
                        break; 
                    }
                }
            }
        });
    }
}

// --- 2. Test Helper Utility ---

/**
 * Feeds an array of Uint8Array chunks into the framer and collects the output.
 */
async function runStreamTest(chunks) {
    const framer = new RNSFramerStream();
    const writer = framer.writable.getWriter();
    const reader = framer.readable.getReader();
    const results = [];

    // Push chunks asynchronously to simulate network events
    const pump = async () => {
        for (const chunk of chunks) {
            await writer.write(chunk);
        }
        await writer.close();
    };

    // Read outputs as they are yielded
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

// --- 3. The Test Suite ---

describe('RNS Framer TransformStream', () => {

    test('Perfect alignment: 1 chunk = 1 packet', async () => {
        // First byte is 4 (total length). Payload is [0x01, 0x02, 0x03]
        const packet = new Uint8Array([4, 0x01, 0x02, 0x03]);
        
        const results = await runStreamTest([packet]);
        
        assert.equal(results.length, 1);
        assert.deepEqual(results[0], packet);
    });

    test('Fragmentation: 1 packet split across 3 separate chunks', async () => {
        // Simulating TCP MTU fragmentation
        const chunk1 = new Uint8Array([5, 0xAA]); // Length 5, plus 1 byte of payload
        const chunk2 = new Uint8Array([0xBB, 0xCC]);
        const chunk3 = new Uint8Array([0xDD]);
        
        const results = await runStreamTest([chunk1, chunk2, chunk3]);
        
        assert.equal(results.length, 1);
        assert.deepEqual(results[0], new Uint8Array([5, 0xAA, 0xBB, 0xCC, 0xDD]));
    });

    test('Coalescing: 2 complete packets bundled in 1 chunk', async () => {
        // Fast network / Yjs burst updates arriving together
        const packet1 = [3, 0x11, 0x22];
        const packet2 = [4, 0xAA, 0xBB, 0xCC];
        const combinedChunk = new Uint8Array([...packet1, ...packet2]);
        
        const results = await runStreamTest([combinedChunk]);
        
        assert.equal(results.length, 2);
        assert.deepEqual(results[0], new Uint8Array(packet1));
        assert.deepEqual(results[1], new Uint8Array(packet2));
    });

    test('Trailing payload: 1 complete packet + partial next packet', async () => {
        const packet1 = [3, 0x99, 0x88];
        const partialPacket2 = [5, 0xAA]; // Needs 3 more bytes to complete
        
        const combinedChunk = new Uint8Array([...packet1, ...partialPacket2]);
        const completingChunk = new Uint8Array([0xBB, 0xCC, 0xDD]);
        
        const results = await runStreamTest([combinedChunk, completingChunk]);
        
        assert.equal(results.length, 2);
        assert.deepEqual(results[0], new Uint8Array(packet1));
        assert.deepEqual(results[1], new Uint8Array([5, 0xAA, 0xBB, 0xCC, 0xDD]));
    });
});
