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
	CharsPerTokenCalibration,
	compact,
	decodeRate,
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
	// Emulate the fs so atomic prefs writes land where the assertions expect them.
	const files = new Map<string, string>();
	let prefSaves = 0;
	t.mock.method(fs.promises, "writeFile", async (filePath: unknown, data: unknown) => {
		files.set(String(filePath), String(data));
	});
	t.mock.method(fs.promises, "rename", async (from: unknown, to: unknown) => {
		const data = files.get(String(from));
		if (data === undefined) {
			throw new Error("ENOENT");
		}
		files.delete(String(from));
		files.set(String(to), data);
		prefSaves += 1;
	});
	t.mock.method(fs.promises, "unlink", async (filePath: unknown) => {
		files.delete(String(filePath));
	});
	const prefsEntries = (): Array<{ path: string; data: string }> =>
		[...files]
			.filter(([filePath]) => filePath.endsWith("live-throughput-prefs.json"))
			.map(([filePath, data]) => ({ path: filePath, data }));

	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ text: string; level: string | undefined }> = [];
	const editors: Array<{ title: string; text: string }> = [];
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
			editor: async (title: string, text: string) => {
				editors.push({ title, text });
				return undefined;
			},
		},
	} as unknown as ExtensionCommandContext;

	liveThroughput(
		{
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				events.set(name, handler),
			registerCommand: (
				name: string,
				command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> },
			) => commands.set(name, command),
		} as unknown as ExtensionAPI,
		// The mocked Date drives the monotonic clock too, so timings stay exact.
		() => Date.now(),
	);

	return {
		ctx,
		statuses,
		notifications,
		get prefWrites() {
			return prefsEntries();
		},
		get prefSaves() {
			return prefSaves;
		},
		editors,
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

async function sendDelta(h: Harness, chars: number, type = "text_delta"): Promise<void> {
	await h.fire("message_update", {
		message: assistant,
		assistantMessageEvent: { type, delta: "x".repeat(chars) },
	});
}

async function endTurn(h: Harness, usage: unknown): Promise<void> {
	await h.fire("message_end", { message: { ...assistant, usage } });
}

/**
 * One assistant turn: a one-token 4-char chunk at t+1.24s (the TTFT) opens the
 * window, then 800 chars a second later — 200 estimated tokens over 1.0s.
 */
async function streamTurn(h: Harness, t: TestContext, usage: unknown = {}): Promise<void> {
	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 4);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 800);
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
	await sendDelta(h, 4);
	// The first token defines the window start, so there is no rate yet.
	assert.equal(h.text(), undefined);

	t.mock.timers.tick(1_000);
	await sendDelta(h, 800);
	// 800 chars after the opening chunk / 4 = ~200 tokens over 1.0s: an estimate.
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");

	await endTurn(h, { input: 1_850, output: 804, cacheRead: 0, cacheWrite: 0 });
	// 800 of the 804 output tokens: the opening chunk's share (4 of 804 chars)
	// was generated before the window. The tilde is gone: usage was reported.
	assert.equal(assertRateOnly(h.text()), "800.0 tok/s");
});

test("no rate is printed before a real decode window, and repaints are throttled", async (t) => {
	const h = harness(t);
	await beginTurn(h);

	t.mock.timers.tick(500);
	await sendDelta(h, 40);
	// 10 estimated tokens in a 0ms window would otherwise render ~10000.0.
	assert.equal(h.text(), undefined);

	t.mock.timers.tick(1_000);
	await sendDelta(h, 8_000);
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
	await streamTurn(h, t, { input: 1_850, output: 804 });
	assert.equal(assertRateOnly(h.text()), "800.0 tok/s");

	// Buffered turn: the provider emits no deltas, so no rate can be timed.
	await h.fire("before_provider_request", { payload: {} });
	await h.fire("message_start", { message: assistant });
	t.mock.timers.tick(3_000);
	await endTurn(h, { input: 300, output: 500 });
	assert.equal(h.text(), "800.0 tok/s");

	// The buffered turn's tokens are still reported by /throughput.
	await h.command("");
	assert.match(h.lastNotification().text, /• decode: 500 tok · rate unavailable/);
});

test("thinking and tool-call deltas count as generated output", async (t) => {
	const h = harness(t);
	await beginTurn(h);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 4, "thinking_delta");
	assert.equal(h.text(), undefined);

	t.mock.timers.tick(1_000);
	await sendDelta(h, 800, "toolcall_delta");
	// Both delta kinds count: 800 timed chars / 4 = ~200 tokens over 1.0s.
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
	await sendDelta(h, 4);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 800);
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");

	await h.command("toggle off");
	assert.equal(h.text(), undefined);
	assert.equal(h.prefSaves, 1);
	assert.match(h.prefWrites[0].path, /live-throughput-prefs\.json$/);
	assert.deepEqual(JSON.parse(h.prefWrites[0].data), { mode: "off" });
	assert.match(h.lastNotification().text, /hidden/);

	// Disabled: no timing, no footer writes at all.
	await sendDelta(h, 4_000);
	await endTurn(h, { input: 1_000, output: 500 });
	assert.equal(h.text(), undefined);
	assert.equal(h.statuses.size, 1); // only the earlier "off" clear

	await h.command("toggle on");
	assert.equal(h.text(), undefined);
	assert.deepEqual(JSON.parse(h.prefWrites[0].data), { mode: "on" });

	// Re-enabled: the next turn measures again.
	await beginTurn(h);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 4);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 800);
	assert.equal(assertRateOnly(h.text()), "~200.0 tok/s");
});

test("toggle accepts explicit modes and rejects unknown ones", async (t) => {
	const h = harness(t);
	await h.fire("session_start");

	await h.command("toggle bogus");
	assert.equal(h.lastNotification().level, "warning");
	assert.match(h.lastNotification().text, /Unknown mode/);
	assert.equal(h.prefSaves, 0);

	await h.command("toggle off");
	await h.command("toggle off");
	assert.equal(h.prefSaves, 2);
	// Idempotent: an explicit mode is applied even when already active.
	assert.equal(h.text(), undefined);
});

test("persisted prefs hide or restore the footer at session start", async (t) => {
	const hidden = harness(t, { prefs: { mode: "off" } });
	await hidden.fire("session_start");
	await beginTurn(hidden);
	t.mock.timers.tick(1_000);
	await sendDelta(hidden, 4);
	t.mock.timers.tick(1_000);
	await sendDelta(hidden, 800);
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
	await sendDelta(h, 4);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 800);
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
	await sendDelta(h, 4);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 800);
	await endTurn(h, { input: 1_850, output: 804, cacheRead: 50_000, cacheWrite: 62 });

	await h.command("");
	const readout = h.lastNotification().text;
	assert.equal(h.lastNotification().level, "info");
	assert.match(readout, /^Live throughput — local-llm • qwen3-32b$/m);
	assert.match(readout, /• TTFT: 1\.24s · Input\/TTFT: ~1\.5k tok\/s/);
	assert.match(readout, /• input: 1\.9k tok \(1\.9k uncached \+ 62 cache write\) · 50k cache read/);
	assert.match(readout, /• decode: 800\.0 tok\/s · 804 output tok · 800 tok timed over 1\.00s/);
	assert.match(readout, /Measured just now/);

	t.mock.timers.tick(120_000);
	await h.command("");
	assert.match(h.lastNotification().text, /Measured 2m ago/);
});

test("hidden reasoning tokens are excluded from the settled rate and named in the readout", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	await beginTurn(h);
	// A reasoning summary streams first, then the answer.
	t.mock.timers.tick(3_000);
	await sendDelta(h, 4, "thinking_delta");
	t.mock.timers.tick(1_000);
	await sendDelta(h, 600, "thinking_delta");
	await sendDelta(h, 4);
	t.mock.timers.tick(2_000);
	await sendDelta(h, 400);
	// 5000 of 5101 output tokens were reasoning; 101 answer tokens span 404 chars.
	await endTurn(h, { input: 1_000, output: 5_101, reasoning: 5_000 });
	// 100 timed answer tokens over the 2s answer span, not 5101 over 3s.
	assert.equal(assertRateOnly(h.text()), "50.0 tok/s");

	await h.command("");
	assert.match(h.lastNotification().text, /• reasoning: 5\.0k tok, excluded/);
});

test("exact turns calibrate the next live estimate for the same model", async (t) => {
	const h = harness(t);
	await h.fire("session_start");
	// 804 chars reported as 402 tokens: this model writes 2 chars per token.
	await streamTurn(h, t, { input: 100, output: 402 });
	assert.equal(assertRateOnly(h.text()), "400.0 tok/s");

	await beginTurn(h);
	t.mock.timers.tick(1_240);
	await sendDelta(h, 4);
	t.mock.timers.tick(1_000);
	await sendDelta(h, 800);
	// 800 chars / 2 calibrated chars per token, not / 4.
	assert.equal(assertRateOnly(h.text()), "~400.0 tok/s");

	await endTurn(h, {});
	await h.command("");
	assert.match(
		h.lastNotification().text,
		/~400\.0 tok\/s · ~400 tok timed \(2\.0 chars\/tok, calibrated\)/,
	);
});

test("/throughput help and unknown subcommands notify without measuring", async (t) => {
	const h = harness(t);
	await h.fire("session_start");

	// Help notifies on screen; unknown-subcommand wording comes from the shared table.
	await h.command("help");
	assert.equal(h.editors.length, 0);
	assert.equal(h.lastNotification().level, "info");
	assert.match(h.lastNotification().text, /Live throughput commands:/);
	assert.match(h.lastNotification().text, /\/throughput toggle \[on\|off\]/);
	assert.match(h.lastNotification().text, /mode: on/);

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
	// 1% of the characters arrived in the window-opening chunk: 792 of 800 tokens timed.
	const span = { chars: 800, firstChunkChars: 8, seconds: 10 };
	assert.equal(finalRateText({ outputTokens: 800, all: span }), "79.2 tok/s");
	// No usage: (440 - 40) chars / 4 over 2s.
	const estimate = { chars: 440, firstChunkChars: 40, seconds: 2 };
	assert.equal(finalRateText({ all: estimate }), "~50.0 tok/s");
	assert.equal(finalRateText({ all: estimate, charsPerToken: 2 }), "~100.0 tok/s");
	// A single chunk opens the window and closes it: nothing was timed.
	const single = { chars: 4, firstChunkChars: 4, seconds: 0 };
	assert.equal(finalRateText({ outputTokens: 1, all: single }), undefined);
	assert.equal(finalRateText({}), undefined);
	assert.equal(processedInputTokens({ uncachedInputTokens: 10, cacheWriteTokens: 5 }), 15);
});

test("the first chunk is excluded in proportion to its size, not as one token", () => {
	// A provider that batches ~100 tokens into its first chunk: half of the
	// 842 reported tokens were generated before the window opened.
	const batched = { chars: 800, firstChunkChars: 400, seconds: 1 };
	assert.equal(finalRateText({ outputTokens: 842, all: batched }), "421.0 tok/s");
});

test("reported reasoning is timed on the answer stream, not the whole delta window", () => {
	// 5000 hidden reasoning tokens, a 600-char summary, then a 404-char answer
	// worth 200 tokens over its own 2s span.
	const measurement = {
		outputTokens: 5_200,
		reasoningTokens: 5_000,
		all: { chars: 1_004, firstChunkChars: 50, seconds: 4 },
		answer: { chars: 404, firstChunkChars: 4, seconds: 2 },
	};
	const result = decodeRate(measurement);
	assert.ok(result);
	assert.equal(result.approximate, false);
	assert.equal(result.excludedReasoningTokens, 5_000);
	assert.equal(finalRateText(measurement), "99.0 tok/s");
	// Dividing every output token by the delta window would claim ~1236 tok/s.
	assert.equal(finalRateText({ ...measurement, reasoningTokens: undefined }), "1235.3 tok/s");
	// Reasoning with no answer deltas to time falls back to the estimate.
	assert.equal(finalRateText({ ...measurement, answer: undefined }), "~59.6 tok/s");
});

test("chars-per-token calibration decays old samples, skips tiny ones, and clamps", () => {
	const calibration = new CharsPerTokenCalibration();
	assert.equal(calibration.get("m"), undefined);
	calibration.record("m", 300, 10);
	assert.equal(calibration.get("m"), undefined);
	calibration.record("m", 3_000, 1_000);
	assert.equal(calibration.get("m"), 3);
	calibration.record("m", 2_000, 1_000);
	// (3000 * 0.7 + 2000) / (1000 * 0.7 + 1000)
	assert.equal(calibration.get("m")?.toFixed(3), "2.412");
	calibration.record("tiny", 1, 1_000);
	assert.equal(calibration.get("tiny"), 0.5);
	assert.equal(calibration.get("other"), undefined);
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
	assert.equal(runReadout(undefined, START), "No measurement yet — send a prompt first.");
	assert.equal(
		runReadout({ provider: "local-llm", model: "qwen3-32b", at: START }, START),
		[
			"Live throughput — local-llm • qwen3-32b",
			"• TTFT: unavailable",
			"• decode: no output tokens",
			"Measured just now",
		].join("\n"),
	);
});
