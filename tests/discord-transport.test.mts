import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { Transport, TransportOptions } from "@xhayper/discord-rpc";
import { WslDiscordIpcTransport } from "../extensions/discord/transport.ts";

// Tests run from a temporary compiled tree. Resolve the actual locked RPC
// dependency from the repository rather than replacing its client with a mock.
const require = createRequire(join(process.cwd(), "package.json"));
const { Client } = require("@xhayper/discord-rpc") as typeof import("@xhayper/discord-rpc");
const CLIENT_ID = "123456789012345678";

function mockRelay(t: TestContext) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const events = new EventEmitter();
	const kill = t.mock.fn(() => {
		queueMicrotask(() => events.emit("close", 0, null));
		return true;
	});
	const relay = Object.assign(events, {
		stdin,
		stdout,
		exitCode: null,
		kill,
	}) as unknown as ChildProcess;
	const handshakes: unknown[] = [];

	stdin.on("data", (packet: Buffer) => {
		assert.equal(packet.readUInt32LE(0), 0);
		handshakes.push(JSON.parse(packet.subarray(8).toString("utf8")));
		const payload = Buffer.from(
			JSON.stringify({
				cmd: "DISPATCH",
				evt: "READY",
				data: { user: { id: "123", username: "test", discriminator: "0", avatar: null } },
			}),
		);
		const response = Buffer.alloc(8 + payload.length);
		response.writeUInt32LE(1, 0);
		response.writeUInt32LE(payload.length, 4);
		payload.copy(response, 8);
		queueMicrotask(() => stdout.write(response));
	});

	const spawn = t.mock.method(childProcess, "spawn", () => {
		queueMicrotask(() => relay.emit("spawn"));
		return relay;
	});
	// The transport imports spawn as an ESM named export.
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});

	return { relay, kill, spawn, handshakes };
}

function createClient() {
	const client = new Client({
		clientId: CLIENT_ID,
		transport: {
			type: WslDiscordIpcTransport as unknown as new (options: TransportOptions) => Transport,
		},
	});
	const transport = client.transport as unknown as WslDiscordIpcTransport;
	return { client, transport };
}

test("WSL relay satisfies the real RPC client's connection and teardown contract", async (t) => {
	const { kill, spawn, handshakes } = mockRelay(t);
	const { client, transport } = createClient();
	t.after(() => client.destroy());

	assert.equal(transport.isOpen, false);
	assert.equal(client.isConnected, false);
	await client.connect();

	assert.deepEqual(handshakes, [{ v: 1, client_id: CLIENT_ID }]);
	assert.equal(spawn.mock.callCount(), 1);
	assert.deepEqual(spawn.mock.calls[0].arguments[1], ["-ep", "//./pipe/discord-ipc-0"]);
	assert.equal(transport.isConnected, true);
	assert.equal(transport.isOpen, true);
	assert.equal(client.isConnected, true);
	assert.ok(client.user);

	await client.destroy();
	assert.equal(kill.mock.callCount(), 1, "RPC destroy must terminate the relay process");
	assert.equal(transport.isOpen, false);
	assert.equal(transport.isConnected, false);
	assert.equal(client.isConnected, false);
	await client.destroy();
	assert.equal(kill.mock.callCount(), 1, "repeated teardown must be harmless");
});

test("WSL relay clears the real RPC client's connection state when Discord exits", async (t) => {
	const { relay } = mockRelay(t);
	const { client, transport } = createClient();
	t.after(() => client.destroy());
	let disconnected = false;
	client.on("disconnected", () => {
		disconnected = true;
	});

	await client.connect();
	assert.equal(client.isConnected, true);
	relay.emit("close", 0, null);

	assert.equal(disconnected, true);
	assert.equal(transport.isOpen, false);
	assert.equal(transport.isConnected, false);
	assert.equal(client.isConnected, false);
});
