import assert from "node:assert";
import {
  Destination,
  DestinationType,
  Direction,
} from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";

async function testDestination() {
  console.log("Testing Destination...");

  const myIdentity = await Identity.generate();

  // Test SINGLE destination
  const singleDest = await Destination.SINGLE(
    "myapp",
    Direction.OUT,
    myIdentity,
  );
  assert.strictEqual(singleDest.type, DestinationType.SINGLE);
  assert.strictEqual(singleDest.direction, Direction.OUT);
  assert.ok(singleDest.destinationHash);
  assert.strictEqual(singleDest.nameHash.length, 10);
  assert.strictEqual(singleDest.destinationHash.length, 16);

  // Test PLAIN destination
  const plainDest = await Destination.PLAIN("someapp", Direction.IN);
  assert.strictEqual(plainDest.type, DestinationType.PLAIN);
  assert.strictEqual(plainDest.direction, Direction.IN);
  assert.ok(plainDest.destinationHash);
  assert.strictEqual(plainDest.destinationHash.length, 16);

  // Test GROUP destination
  const groupDest = await Destination.GROUP(
    "mygroup",
    Direction.OUT,
    myIdentity,
  );
  assert.strictEqual(groupDest.type, DestinationType.GROUP);
  assert.strictEqual(groupDest.direction, Direction.OUT);
  assert.ok(groupDest.destinationHash);
  assert.strictEqual(groupDest.destinationHash.length, 16);

  // Test IN/OUT helpers
  const inDest = await Destination.IN(
    "myapp",
    DestinationType.SINGLE,
    myIdentity,
  );
  assert.strictEqual(inDest.direction, Direction.IN);
  assert.ok(inDest.destinationHash);

  const outDest = await Destination.OUT(
    "myapp",
    DestinationType.SINGLE,
    myIdentity,
  );
  assert.strictEqual(outDest.direction, Direction.OUT);
  assert.ok(outDest.destinationHash);

  console.log("Destination tests passed!");
}

testDestination().catch((err) => {
  console.error("Tests failed!");
  console.error(err);
  process.exit(1);
});
