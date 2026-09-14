import assert from "node:assert/strict";
import fs from "node:fs";
import test, { type TestContext } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import liveThroughput, {
	ageLabel,
	compact,
	deltaChars,
	finalStatusText,
	liveStatusText,
	normalizePrefs,
	processedInputTokens,
	runReadout,
} from "../extensions/live-throughput-status.ts";

const START = 1_800_000_000_000;
const STATUS_KEY = "live-throughput";
/** Mock timers are per test, but a few tests build more than one harness. */
const timersReady = new WeakSet<TestContext>();

interface HarnessOptions {
	prefs?: unknown;
	/** Raw prefs file body; used to exercise malformed JSON. */
	rawPrefs?: string;
	hasUI?: boolean;
}

/**
 * Harness around the extension's registered events and command. Time is
 * mocked so TTFT/decode arithmetic is asserted against exact values, and fs is
 * mocked so prefs never touch the real ~/.pi/agent directory.
 */
function harness(t: TestContext, options: HarnessOptions = {}) {
	if (timersReady.has(t)) {
		// A second harness in the same test rewinds and reuses the mocked clock.
		t.mock.timers.setTime(START);
	} else {
		t.mock.timers.enable({ apis: ["Date"], now: START });
		timersReady.add(t);
	}
	t.mock.method(console, "error", () => {});
	t.mock.method(
		fs,
		"readFileSync",
		() => options.rawPrefs ?? JSON.stringify(options.prefs ?? { mode: "on" }),
	);
	t.mock.method(fs.promises, "mkdir", async () => undefined);
	const prefWrites: Array<{ path: unknown; data: unknown }> = [];
	t.mock.method(fs.promises, "writeFile", async (filePath: unknown, data: unknown) => {
		prefWrites.push({ path: filePath, data });
	});

	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ text: string; level: string | undefined }> = [];
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<
		string,
		{ handler(args: string, ctx: ExtensionCommandContext): Promise<void> }
	>();

	const ctx = {
		mode: "tui",
		hasUI: options.hasUI ?? true,
		model: { provider: "local-llm", id: "qwen3-32b" },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
			notify: (text: string, level?: string) => {
				notifications.push({ text, level });
			},
		},
	} as unknown as ExtensionCommandContext;

	liveThroughput({
		on: (
			name: string,
			handler: (event: unknown, ctx: ExtensionContext) => unknown,
		) => events.set(name, handler),
		registerCommand: (
			name: string,
			command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> },
		) => commands.set(name, command),
	} as unknown as ExtensionAPI);

	return {
		ctx,
		statuses,
		notifications,
		prefWrites,
		async fire(name: string, event: unknown = {}): Promise<void> {
			const handler = events.get(name);
			assert.ok(handler, `no handler registered for ${name}`);
			await handler(event, ctx);
		},
		async command(args: string): Promise<void> {
			const entry = commands.get("throughput");
			assert.ok(entry, "throughput command not registered");
			await entry.handler(args, ctx);
		},
		/** Footer text without the emoji label, so assertions stay readable. */
		text(): string | undefined {
			const raw = statuses.get(STATUS_KEY);
			return raw === undefined ? undefined : raw.replace("⚡ ", "");
		},
		lastNotification(): { text: string; level: string | undefined } {
			const last = notifications.at(-1);
			assert.ok(last, "no notification recorded");
			return last;
		},
	};
}

type Harness = ReturnType<typeof harness>;

const assistant = { role: "assistant" };

/** Open a turn: provider request hook, then the assistant message start. */
async function beginTurn(h: Harness): Promise<void> {
	await h.fire("before_provider_request", { payload: {} });
	await h.fire("message_start", { message: assistant });
}

async function sendDelta(
	h: Harness,
	chars: number,
	type = "text_delta",
): Promise<void> {
	await h.fire("message_update", {
		message: assistant,
		assistantMessageEvent: { type, delta: "x".repeat(chars) },
	});
}

async function endTurn(h: Harness, usage: unknown): Promise<void> {
	await h.fire("message_end", { message: { ...assistant, usage } });
}

test("footer reports TTFT, a live estimate, then exact usage tokens", async (t) => {
	const h = harness(t);
	await h.fire("session_start", { reason: "startup" });
	assert.equal(h.text(), "TTFT: waiting · Decode: waiting");

	await beginTurn(h);
	assert.equal(h.text(), "TTFT: waiting · Decode: waiting for first token…");

	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);
	assert.equal(h.text(), "TTFT: 1.24s · Decode: measuring… · ~100 tok");

	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	// 800 chars / 4 = ~200 tokens over a 1.0s decode window.
	assert.equal(h.text(), "TTFT: 1.24s · Decode: ~200.0 tok/s · ~200 tok");

	await endTurn(h, { input: 1_850, output: 842, cacheRead: 0, cacheWrite: 0 });
	// 841 = 842 output tokens minus the first token that defines the boundary.
	assert.equal(
		h.text(),
		"TTFT: 1.24s · Input/TTFT: ~1491.9 tok/s · Decode: 841.0 tok/s · 842 tok",
	);
});

test("first delta never prints a divide-by-near-zero rate", async (t) => {
	const h = harness(t);
	await beginTurn(h);
	t.mock.timers.tick(500);
	await sendDelta(h, 4_000);
	// 1000 estimated tokens in a 0ms window would otherwise render as ~1000000.0.
	assert.equal(h.text(), "TTFT: 0.50s · Decode: measuring… · ~1000 tok");

	t.mock.timers.tick(200);
	await sendDelta(h, 1);
	assert.match(h.text()!, /Decode: ~\d+\.\d tok\/s/);
});

test("cache reads are excluded from Input/TTFT but cache writes count", async (t) => {
	const cached = harness(t);
	await beginTurn(cached);
	t.mock.timers.tick(1_240);
	await sendDelta(cached, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(cached, 400);
	await endTurn(cached, { input: 0, output: 100, cacheRead: 50_000, cacheWrite: 0 });
	assert.equal(cached.text(), "TTFT: 1.24s · Decode: 99.0 tok/s · 100 tok");
	assert.doesNotMatch(cached.text()!, /Input\/TTFT/);

	const writing = harness(t);
	await beginTurn(writing);
	t.mock.timers.tick(1_240);
	await sendDelta(writing, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(writing, 400);
	await endTurn(writing, { input: 1_000, output: 100, cacheRead: 50_000, cacheWrite: 240 });
	// (1000 uncached + 240 cache write) / 1.24s TTFT
	assert.equal(
		writing.text(),
		"TTFT: 1.24s · Input/TTFT: ~1000.0 tok/s · Decode: 99.0 tok/s · 100 tok",
	);
});

test("providers without usage keep the chars/4 estimate", async (t) => {
	const h = harness(t);
	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	await endTurn(h, {});
	assert.equal(h.text(), "TTFT: 1.24s · Decode: ~200.0 tok/s · ~200 tok");
});

test("buffered providers report token counts without a rate", async (t) => {
	const h = harness(t);
	await beginTurn(h);
	assert.equal(h.text(), "TTFT: waiting · Decode: waiting for first token…");
	await endTurn(h, { input: 300, output: 500 });
	// No deltas were observed, so no client-timed decode window exists.
	assert.equal(h.text(), "Decode: 500 tok · rate unavailable");
});

test("thinking and tool-call deltas count as generated output", async (t) => {
	const h = harness(t);
	await beginTurn(h);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400, "thinking_delta");
	assert.equal(h.text(), "TTFT: 1.00s · Decode: measuring… · ~100 tok");

	t.mock.timers.tick(1_000);
	await sendDelta(h, 400, "toolcall_delta");
	assert.equal(h.text(), "TTFT: 1.00s · Decode: ~200.0 tok/s · ~200 tok");
});

test("non-delta stream events and non-assistant messages are ignored", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await beginTurn(h);
	const waiting = h.text();

	t.mock.timers.tick(1_000);
	await h.fire("message_update", {
		message: assistant,
		assistantMessageEvent: { type: "text_start", delta: "x".repeat(100) },
	});
	await h.fire("message_update", {
		message: assistant,
		assistantMessageEvent: { type: "text_delta", delta: 42 },
	});
	assert.equal(h.text(), waiting);

	await h.fire("message_start", { message: { role: "user" } });
	await h.fire("message_update", {
		message: { role: "user" },
		assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
	});
	await h.fire("message_end", { message: { role: "user", usage: { output: 12 } } });
	assert.equal(h.text(), waiting);
});

test("a finalized message with nothing measured keeps the previous line", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await h.fire("message_end", { message: { ...assistant, usage: {} } });
	// session_start's waiting line survives: a restored transcript entry must
	// not overwrite the footer with an empty measurement.
	assert.equal(h.text(), "TTFT: waiting · Decode: waiting");
});

test("toggle off clears the line, stops measuring, and persists the choice", async (t) => {
	const h = harness(t);
	await h.fire("session_start", { reason: "startup" });
	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);

	await h.command("toggle off");
	assert.equal(h.text(), undefined);
	assert.equal(h.prefWrites.length, 1);
	assert.match(String(h.prefWrites[0].path), /live-throughput-prefs\.json$/);
	assert.deepEqual(JSON.parse(String(h.prefWrites[0].data)), { mode: "off" });
	assert.match(h.lastNotification().text, /hidden/);

	// Disabled: no timing, no footer writes at all.
	await sendDelta(h, 4_000);
	await endTurn(h, { input: 1_000, output: 500 });
	assert.equal(h.text(), undefined);

	await h.command("toggle on");
	assert.equal(h.text(), undefined);
	assert.deepEqual(JSON.parse(String(h.prefWrites[1].data)), { mode: "on" });

	// Re-enabled: the next turn measures again.
	await beginTurn(h);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	assert.equal(h.text(), "TTFT: 1.00s · Decode: measuring… · ~100 tok");
});

test("toggle accepts explicit modes and rejects unknown ones", async (t) => {
	const h = harness(t);
	await h.fire("session_start");

	await h.command("toggle bogus");
	assert.equal(h.lastNotification().level, "warning");
	assert.match(h.lastNotification().text, /Unknown mode/);
	assert.equal(h.prefWrites.length, 0);

	await h.command("toggle off");
	await h.command("toggle off");
	assert.equal(h.prefWrites.length, 2);
	// Idempotent: an explicit mode is applied even when already active.
	assert.equal(h.text(), undefined);
});

test("persisted prefs hide or restore the footer at session start", async (t) => {
	const hidden = harness(t, { prefs: { mode: "off" } });
	await hidden.fire("session_start");
	assert.equal(hidden.text(), undefined);

	await hidden.command("");
	assert.match(hidden.lastNotification().text, /No measurement yet/);
	assert.match(hidden.lastNotification().text, /Footer hidden/);

	const shown = harness(t, { prefs: { mode: "on" } });
	await shown.fire("session_start");
	assert.equal(shown.text(), "TTFT: waiting · Decode: waiting");
});

test("malformed or unknown prefs fall back to a visible footer", async (t) => {
	const malformed = harness(t, { rawPrefs: "{not json" });
	await malformed.fire("session_start");
	assert.equal(malformed.text(), "TTFT: waiting · Decode: waiting");

	const unknown = harness(t, { prefs: { mode: "sometimes" } });
	await unknown.fire("session_start");
	assert.equal(unknown.text(), "TTFT: waiting · Decode: waiting");
});

test("sessions without a UI never write status", async (t) => {
	const h = harness(t, { hasUI: false });
	await h.fire("session_start");
	await beginTurn(h);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	await endTurn(h, { input: 10, output: 20 });
	await h.command("toggle off");
	assert.equal(h.statuses.size, 0);
});

test("model switches reset the measurement", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);
	assert.match(h.text()!, /TTFT: 1.24s/);

	await h.fire("model_select", { source: "cycle" });
	assert.equal(h.text(), "TTFT: waiting · Decode: waiting");

	// The next turn measures TTFT from its own request hook, not the old one.
	t.mock.timers.tick(5_000);
	await beginTurn(h);
	t.mock.timers.tick(750);
	await sendDelta(h, 400);
	assert.equal(h.text(), "TTFT: 0.75s · Decode: measuring… · ~100 tok");
});

test("session shutdown clears the footer", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await h.fire("session_shutdown", { reason: "quit" });
	assert.deepEqual(h.statuses.get(STATUS_KEY), undefined);
});

test("/throughput summarizes the last measurement with freshness", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	await endTurn(h, { input: 1_850, output: 842, cacheRead: 50_000, cacheWrite: 62 });

	await h.command("");
	const readout = h.lastNotification().text;
	assert.equal(h.lastNotification().level, "info");
	assert.match(readout, /^Live throughput — local-llm • qwen3-32b$/m);
	assert.match(readout, /• TTFT: 1\.24s · Input\/TTFT: ~1\.5k tok\/s/);
	assert.match(readout, /• input: 1\.9k tok \(1\.9k uncached \+ 62 cache write\) · 50k cache read/);
	assert.match(readout, /• decode: 841\.0 tok\/s · 842 tok over 1\.00s/);
	assert.match(readout, /Measured just now/);

	t.mock.timers.tick(120_000);
	await h.command("");
	assert.match(h.lastNotification().text, /Measured 2m ago/);
});

test("/throughput help and unknown subcommands notify without measuring", async (t) => {
	const h = harness(t);
	await h.fire("session_start");

	await h.command("help");
	assert.match(h.lastNotification().text, /Live throughput commands:/);

	await h.command("explode");
	assert.equal(h.lastNotification().level, "warning");
	assert.match(h.lastNotification().text, /Unknown subcommand "explode"/);
});

test("deltaChars counts text, thinking, and tool-call deltas only", () => {
	assert.equal(deltaChars({ type: "text_delta", delta: "abcd" }), 4);
	assert.equal(deltaChars({ type: "thinking_delta", delta: "ab" }), 2);
	assert.equal(deltaChars({ type: "toolcall_delta", delta: "a" }), 1);
	assert.equal(deltaChars({ type: "text_start", delta: "abcd" }), 0);
	assert.equal(deltaChars({ type: "text_delta", delta: 42 }), 0);
	assert.equal(deltaChars({ type: "text_delta" }), 0);
	assert.equal(deltaChars(undefined), 0);
	assert.equal(deltaChars("text_delta"), 0);
	assert.equal(deltaChars([{ type: "text_delta", delta: "x" }]), 0);
});

test("liveStatusText defers until a decode window exists", () => {
	assert.equal(
		liveStatusText(1.24, 100, 0),
		"TTFT: 1.24s · Decode: measuring… · ~100 tok",
	);
	assert.equal(
		liveStatusText(1.24, 100, 0.199),
		"TTFT: 1.24s · Decode: measuring… · ~100 tok",
	);
	assert.equal(
		liveStatusText(1.24, 200, 1),
		"TTFT: 1.24s · Decode: ~200.0 tok/s · ~200 tok",
	);
});

test("finalStatusText prefers exact usage and marks estimates", () => {
	assert.equal(
		finalStatusText({
			ttftSeconds: 1.24,
			uncachedInputTokens: 1_850,
			cacheWriteTokens: 62,
			outputTokens: 842,
			decodeSeconds: 20,
			streamedChars: 3_400,
		}),
		"TTFT: 1.24s · Input/TTFT: ~1541.9 tok/s · Decode: 42.0 tok/s · 842 tok",
	);
	assert.equal(
		finalStatusText({ outputTokens: 1, decodeSeconds: 0, streamedChars: 0 }),
		"Decode: 1 tok · rate unavailable",
	);
	assert.equal(
		finalStatusText({ ttftSeconds: 0.5, streamedChars: 400, decodeSeconds: 2 }),
		"TTFT: 0.50s · Decode: ~50.0 tok/s · ~100 tok",
	);
	assert.equal(
		finalStatusText({ streamedChars: 0 }),
		"Decode: no output tokens",
	);
	assert.equal(
		processedInputTokens({ uncachedInputTokens: 10, cacheWriteTokens: 5 }),
		15,
	);
});

test("compact, ageLabel, normalizePrefs, and runReadout handle edge inputs", () => {
	assert.equal(compact(842), "842");
	assert.equal(compact(1_850), "1.9k");
	assert.equal(compact(50_000), "50k");
	assert.equal(compact(1_234_567), "1.2M");
	assert.equal(ageLabel(0), "just now");
	assert.equal(ageLabel(59_999), "just now");
	assert.equal(ageLabel(3_600_000), "1h ago");
	assert.equal(ageLabel(2 * 86_400_000), "2d ago");
	assert.deepEqual(normalizePrefs(undefined), { mode: "on" });
	assert.deepEqual(normalizePrefs({ mode: "off" }), { mode: "off" });
	assert.deepEqual(normalizePrefs("off"), { mode: "on" });
	assert.equal(
		runReadout(undefined, START),
		"No measurement yet — send a prompt first.",
	);
	assert.equal(
		runReadout(
			{ provider: "local-llm", model: "qwen3-32b", streamedChars: 0, at: START },
			START,
		),
		[
			"Live throughput — local-llm • qwen3-32b",
			"• TTFT: unavailable",
			"• decode: no output tokens",
			"Measured just now",
		].join("\n"),
	);
});
