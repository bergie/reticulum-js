import { Identity } from '../../src/core/identity.js';
import { Destination, DestinationType } from '../../src/core/destination.js';
import assert from 'node:assert';

async function testDestination() {
    console.log("Testing Destination...");

    const myIdentity = await Identity.generate();

    // Test SINGLE destination
    const singleDest = await Destination.SINGLE("myapp", myIdentity);
    assert.strictEqual(singleDest.type, DestinationType.SINGLE);
    assert.ok(singleDest.destination_hash);
    assert.strictEqual(singleDest.name_hash.length, 10);
    assert.strictEqual(singleDest.destination_hash.length, 16);

    // Test PLAIN destination
    const plainDest = await Destination.PLAIN("someapp");
    assert.strictEqual(plainDest.type, DestinationType.PLAIN);
    assert.ok(plainDest.destination_hash);
    assert.strictEqual(plainDest.destination_hash.length, 16);

    // Test GROUP destination
    const groupDest = await Destination.GROUP("mygroup", myIdentity);
    assert.strictEqual(groupDest.type, DestinationType.GROUP);
    assert.ok(groupDest.destination_hash);
    assert.strictEqual(groupDest.destination_hash.length, 16);

    console.log("Destination tests passed!");
}

testDestination().catch(err => {
    console.error("Tests failed!");
    console.error(err);
    process.exit(1);
});
