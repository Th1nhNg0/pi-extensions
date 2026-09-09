import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDeferredCores } from "../extensions/deferred-extension.ts";
import registerStartupEntries from "../extensions/startup-entry.ts";

test("deferred cores preserve registration order and replay every session_start handler", async () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	const calls: string[] = [];
	let loads = 0;

	const sessionStarts = await registerDeferredCores(pi, async () => {
		loads += 1;
		return [{
			default: (deferredPi) => {
				const events = deferredPi as unknown as {
					on(event: string, handler: () => void): void;
				};
				events.on("session_start", () => calls.push("first"));
				events.on("session_start", () => calls.push("second"));
				events.on("agent_start", () => calls.push("forwarded"));
			},
		}];
	});

	assert.equal(loads, 1);
	assert.equal(sessionStarts.length, 2);
	assert.equal(handlers.get("agent_start")?.length, 1);
	const ctx = {} as ExtensionContext;
	for (const handler of sessionStarts) await handler({ type: "session_start" }, ctx);
	assert.deepEqual(calls, ["first", "second"]);

	for (const handler of sessionStarts) await handler({ type: "session_start" }, ctx);
	assert.equal(loads, 1);
	assert.deepEqual(calls, ["first", "second", "first", "second"]);
});

test("startup entry registers no core work before session_start", () => {
	const events: string[] = [];
	let commands = 0;
	const pi = {
		on(event: string) {
			events.push(event);
		},
		registerCommand() {
			commands += 1;
		},
	} as unknown as ExtensionAPI;

	registerStartupEntries(pi);

	assert.deepEqual(events, ["session_start"]);
	assert.equal(commands, 0);
});
