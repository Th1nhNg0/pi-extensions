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
	finalRateText,
	normalizePrefs,
	processedInputTokens,
	rateStatusText,
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
 * mocked so the rate arithmetic is asserted against exact values, and fs is
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

/**
 * The footer carries exactly one short value — the rate — so every rendered
 * line must match this shape. Returns the text for further assertions.
 */
function assertRateOnly(text: string | undefined): string {
	assert.ok(text !== undefined, "expected a footer line");
	assert.match(text, /^~?\d+\.\d tok\/s$/);
	return text;
}

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

/**
 * One assistant turn: 400 chars at t+1.24s (the TTFT), then 400 more a second
 * later — a 1.0s decode window carrying 200 estimated tokens.
 */
async function streamTurn(
	h: Harness,
	t: TestContext,
	usage: unknown = {},
): Promise<void> {
	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	await endTurn(h, usage);
}

test("footer shows a live estimate, then the exact rate from usage", async (t) => {
	const h = harness(t);
	await h.fire("session_start", { reason: "startup" });
	// No placeholder: nothing is printed until a rate is measurable.
	assert.equal(h.text(), undefined);

	await beginTurn(h);
	assert.equal(h.text(), undefined);

	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);
	// The first token defines the window start, so there is no rate yet.
	assert.equal(h.text(), undefined);

	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	// 800 chars / 4 = ~200 tokens over a 1.0s window, so the rate is estimated.
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");

	await endTurn(h, { input: 1_850, output: 842, cacheRead: 0, cacheWrite: 0 });
	// 841 = 842 output tokens minus the first token that defines the boundary;
	// the tilde is gone because the provider reported usage.
	assert.equal(assertRateOnly(h.text()), "841.0 tok/s");
});

test("no rate is printed before a real decode window, and repaints are throttled", async (t) => {
	const h = harness(t);
	await beginTurn(h);

	t.mock.timers.tick(500);
	await sendDelta(h, 4_000);
	// 1000 estimated tokens in a 0ms window would otherwise render ~1000000.0.
	assert.equal(h.text(), undefined);

	t.mock.timers.tick(1_000);
	await sendDelta(h, 4_000);
	const shown = assertRateOnly(h.text());
	assert.equal(shown, "~2000.0 tok/s");

	t.mock.timers.tick(100);
	await sendDelta(h, 400);
	// < 200ms since the last write: the TUI is spared the repaint.
	assert.equal(h.text(), shown);

	t.mock.timers.tick(100);
	await sendDelta(h, 400);
	assert.notEqual(h.text(), shown);
	assert.equal(assertRateOnly(h.text()), "~1833.3 tok/s");
});

test("Input/TTFT excludes cache reads and includes cache writes (readout)", async (t) => {
	const cached = harness(t);
	await streamTurn(cached, t, { input: 0, output: 100, cacheRead: 50_000, cacheWrite: 0 });
	await cached.command("");
	// Everything the footer no longer shows is reported by /throughput instead.
	assert.doesNotMatch(cached.lastNotification().text, /Input\/TTFT/);
	assert.match(cached.lastNotification().text, /50k cache read/);

	const writing = harness(t);
	await streamTurn(writing, t, { input: 1_000, output: 100, cacheRead: 50_000, cacheWrite: 240 });
	await writing.command("");
	// (1000 uncached + 240 cache write) / 1.24s TTFT
	assert.match(writing.lastNotification().text, /Input\/TTFT: ~1\.0k tok\/s/);
});

test("providers without usage keep the chars/4 estimate in the footer", async (t) => {
	const h = harness(t);
	await streamTurn(h, t, {});
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");
});

test("a provider that streams no deltas leaves the last measured rate", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await streamTurn(h, t, { input: 1_850, output: 842 });
	assert.equal(assertRateOnly(h.text()), "841.0 tok/s");

	// Buffered turn: the provider emits no deltas, so no rate can be timed.
	await h.fire("before_provider_request", { payload: {} });
	await h.fire("message_start", { message: assistant });
	t.mock.timers.tick(3_000);
	await endTurn(h, { input: 300, output: 500 });
	assert.equal(h.text(), "841.0 tok/s");

	// The buffered turn's tokens are still reported by /throughput.
	await h.command("");
	assert.match(h.lastNotification().text, /• decode: 500 tok · rate unavailable/);
});

test("thinking and tool-call deltas count as generated output", async (t) => {
	const h = harness(t);
	await beginTurn(h);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400, "thinking_delta");
	assert.equal(h.text(), undefined);

	t.mock.timers.tick(1_000);
	await sendDelta(h, 400, "toolcall_delta");
	// Both delta kinds count: 800 chars / 4 = ~200 tokens over 1.0s.
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");
});

test("non-delta stream events and non-assistant messages are ignored", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await beginTurn(h);

	t.mock.timers.tick(1_000);
	await h.fire("message_update", {
		message: assistant,
		assistantMessageEvent: { type: "text_start", delta: "x".repeat(100) },
	});
	await h.fire("message_update", {
		message: assistant,
		assistantMessageEvent: { type: "text_delta", delta: 42 },
	});
	assert.equal(h.text(), undefined);

	await h.fire("message_start", { message: { role: "user" } });
	await h.fire("message_update", {
		message: { role: "user" },
		assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
	});
	await h.fire("message_end", { message: { role: "user", usage: { output: 12 } } });
	assert.equal(h.text(), undefined);
});

test("a finalization with nothing measured prints no placeholder", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await h.fire("message_end", { message: { ...assistant, usage: {} } });
	assert.equal(h.text(), undefined);
});

test("toggle off clears the line, stops measuring, and persists the choice", async (t) => {
	const h = harness(t);
	await h.fire("session_start", { reason: "startup" });
	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");

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
	assert.equal(h.statuses.size, 1); // only the earlier "off" clear

	await h.command("toggle on");
	assert.equal(h.text(), undefined);
	assert.deepEqual(JSON.parse(String(h.prefWrites[1].data)), { mode: "on" });

	// Re-enabled: the next turn measures again.
	await beginTurn(h);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");
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
	await beginTurn(hidden);
	t.mock.timers.tick(1_000);
	await sendDelta(hidden, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(hidden, 400);
	assert.equal(hidden.statuses.size, 0);

	await hidden.command("");
	assert.match(hidden.lastNotification().text, /No measurement yet/);
	assert.match(hidden.lastNotification().text, /Footer hidden/);

	const shown = harness(t, { prefs: { mode: "on" } });
	await shown.fire("session_start");
	await streamTurn(shown, t, {});
	assert.equal(assertRateOnly(shown.text()), "~200.0 tok/s");
});

test("malformed or unknown prefs fall back to a visible footer", async (t) => {
	const malformed = harness(t, { rawPrefs: "{not json" });
	await malformed.fire("session_start");
	await streamTurn(malformed, t, {});
	assert.equal(assertRateOnly(malformed.text()), "~200.0 tok/s");

	const unknown = harness(t, { prefs: { mode: "sometimes" } });
	await unknown.fire("session_start");
	await streamTurn(unknown, t, {});
	assert.equal(assertRateOnly(unknown.text()), "~200.0 tok/s");
});

test("sessions without a UI never write status", async (t) => {
	const h = harness(t, { hasUI: false });
	await h.fire("session_start");
	await streamTurn(h, t, { input: 10, output: 20 });
	await h.command("toggle off");
	assert.equal(h.statuses.size, 0);
});

test("model switches drop the stale rate and measure anew", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await streamTurn(h, t, {});
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");

	await h.fire("model_select", { source: "cycle" });
	assert.equal(h.text(), undefined);

	// The next turn measures from its own request hook, not the previous one.
	t.mock.timers.tick(5_000);
	await beginTurn(h);
	t.mock.timers.tick(750);
	await sendDelta(h, 400);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 400);
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");
	await endTurn(h, {});


	await h.command("");
	assert.match(h.lastNotification().text, /• TTFT: 0\.75s/);
});

test("session shutdown clears the footer", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await streamTurn(h, t, {});
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

test("rateStatusText marks estimated rates with a tilde", () => {
	assert.equal(rateStatusText(42.05, true), "~42.0 tok/s");
	assert.equal(rateStatusText(39.84, false), "39.8 tok/s");
	assert.equal(rateStatusText(-5, false), "0.0 tok/s");
});

test("finalRateText prefers usage, then the estimate, then nothing", () => {
	assert.equal(
		finalRateText({ outputTokens: 842, decodeSeconds: 20, streamedChars: 3_400 }),
		"42.0 tok/s",
	);
	assert.equal(
		finalRateText({ outputTokens: 5, streamedChars: 400, decodeSeconds: 2 }),
		"2.0 tok/s",
	);
	assert.equal(
		finalRateText({ streamedChars: 400, decodeSeconds: 2 }),
		"~50.0 tok/s",
	);
	assert.equal(
		finalRateText({ outputTokens: 1, decodeSeconds: 0, streamedChars: 0 }),
		undefined,
	);
	assert.equal(finalRateText({ streamedChars: 0 }), undefined);
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
