import assert from "node:assert";
import { test } from "node:test";
import {
	DestType,
	HeaderType,
	Packet,
	PacketType,
} from "../../src/core/packet.js";
import {
	TCPClientInterface,
	TCPServerInterface,
} from "../../src/interfaces/tcp.js";

test("TCP interface connection and packet transfer", async (t) => {
	const port = 12345;
	const server = new TCPServerInterface({ port });
	const client = new TCPClientInterface({ host: "127.0.0.1", port });

	const connectionPromise = new Promise((resolve) => {
		server.addEventListener("connection", (event) => {
			resolve(event.detail);
		});
	});

	await server.connect();
	await client.connect();

	assert.ok(server.online);
	assert.ok(client.online);

	const connectedClient = await connectionPromise;
	assert.ok(connectedClient, "Server should have spawned a client interface");

	const destHash = new Uint8Array(16).fill(0);
	const payload = new TextEncoder().encode("Hello Reticulum!");
	const packet = new Packet({
		headerType: HeaderType.HEADER_1,
		hops: 0,
		transportType: 0,
		destinationType: DestType.PLAIN,
		packetType: PacketType.DATA,
		contextFlag: false,
		destinationHash: destHash,
		contextByte: 0,
		payload: payload,
	});

	// Test client to server
	const clientWriter = client.writable.getWriter();
	await clientWriter.write(packet);
	clientWriter.releaseLock();

	// Get the readable stream from the client on the server side
	const serverClientReadable = connectedClient.readable;
	const reader = serverClientReadable.getReader();

	const { value: receivedPacket, done } = await reader.read();
	assert.ok(!done);
	assert.ok(receivedPacket);
	assert.strictEqual(
		new TextDecoder().decode(receivedPacket.payload),
		"Hello Reticulum!",
	);

	// Test server to client
	const serverClientWriter = connectedClient.writable.getWriter();
	await serverClientWriter.write(packet);
	serverClientWriter.releaseLock();

	const clientReadable = client.readable;
	const clientReader = clientReadable.getReader();
	const { value: receivedPacketFromServer, done: clientDone } =
		await clientReader.read();

	assert.ok(!clientDone);
	assert.ok(receivedPacketFromServer);
	assert.strictEqual(
		new TextDecoder().decode(receivedPacketFromServer.payload),
		"Hello Reticulum!",
	);

	await client.disconnect();
	await server.disconnect();
});
