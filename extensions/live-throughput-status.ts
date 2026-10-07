/**
 * Live throughput status extension.
 *
 * Adds a model-neutral streaming-throughput line to Pi's footer status area,
 * directly below the model/thinking indicator and the subscription-usage line:
 *
 *   ⚡ ~42.1 tok/s        ← during a stream (characters-per-token estimate)
 *   ⚡ 39.8 tok/s         ← once the message settles (reported output tokens)
 *
 * The footer carries one number only: decode throughput. Live TPS is a
 * characters-per-token estimate — hence the `~` — because most providers do
 * not report a cumulative token count on every stream chunk; it starts at 4
 * and is calibrated per model from every exact turn. The `~` disappears when
 * the provider reports token usage on `message_end`: the reported output
 * tokens are then spread over the client-observed first-to-last delta
 * interval, minus the share of the chunk that opened it. When usage breaks
 * out reasoning tokens, the answer tokens are timed over the answer deltas
 * instead, because hidden or summarized reasoning was generated outside the
 * observed stream. A provider that streams no deltas, or reports no usage,
 * has no rate to show and simply leaves the most recent one in place.
 *
 * Everything else lives in `/throughput` instead of the footer: TTFT (from
 * Pi's `before_provider_request` hook to the first observed output delta), the
 * uncached/cached input split, and the decode window. TTFT also contains
 * network, queue, scheduling, and stream-start overhead, so the `Input/TTFT`
 * estimate it feeds is a client-side prompt-rate comparison, not authoritative
 * server prefill throughput; cache reads are excluded because the model never
 * re-read them.
 *
 * Everything is derived from the standard assistant-stream events, so no
 * provider id, model id, or server log is referenced anywhere. `/throughput`
 * shows the last measurement; bare `/throughput` opens an interactive TUI
 * settings menu (like `/goal`), while `/throughput toggle [on|off]` hides or
 * reveals the line directly. The choice persists in
 * the Pi agent directory (`~/.pi/agent` by default; honors `PI_CODING_AGENT_DIR`).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	agentFilePath,
	argumentCompletions,
	commandHelp,
	cycleMode,
	loadPrefs,
	parseMode,
	parseSubcommand,
	savePrefs,
	showHelp,
	unknownMode,
	unknownSubcommand,
	type CommandSpec,
} from "./shared/command-kit.ts";
import { asRecord } from "./shared/record-guards.ts";
import { menuSupported, showExtensionMenu } from "./shared/settings-menu.ts";

const STATUS_KEY = "live-throughput";
const LABEL = "⚡";
const CHARS_PER_TOKEN = 4;
const UPDATE_INTERVAL_MS = 200;
/**
 * A live rate needs a real decode window: the first delta arrives with zero
 * elapsed stream time, and dividing by the sub-millisecond floor would print a
 * six-digit TPS. Until this much stream time has passed, the previous rate (or
 * nothing, in a fresh session) stays on the footer.
 */
const MIN_LIVE_RATE_SECONDS = UPDATE_INTERVAL_MS / 1000;
const PREFS_FILE = "live-throughput-prefs.json";

export type ThroughputMode = "on" | "off";

export const THROUGHPUT_MODES: readonly ThroughputMode[] = ["on", "off"];

export interface ThroughputPrefs {
	mode: ThroughputMode;
}

const DEFAULT_PREFS: ThroughputPrefs = { mode: "on" };

export function normalizeThroughputMode(value: unknown): ThroughputMode | undefined {
	return typeof value === "string" && (THROUGHPUT_MODES as readonly string[]).includes(value)
		? (value as ThroughputMode)
		: undefined;
}

/** Decode persisted prefs defensively; anything unknown falls back to "on". */
export function normalizePrefs(raw: unknown): ThroughputPrefs {
	const mode = normalizeThroughputMode(asRecord(raw)?.mode);
	return { mode: mode ?? DEFAULT_PREFS.mode };
}

/** One table drives the help, the completions, and the unknown-subcommand message. */
export const THROUGHPUT_SPECS: readonly CommandSpec[] = [
	{ name: "", description: "detailed readout of the last measurement" },
	{ name: "toggle", values: THROUGHPUT_MODES, description: "show or hide the footer line" },
	{ name: "help", description: "show this help" },
];

/** Provider usage counts: finite and strictly positive, else undefined. */
export function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Stream deltas that carry generated output, and whether they belong to the answer. */
const DELTA_KINDS: Readonly<Record<string, "answer" | "thinking">> = {
	text_delta: "answer",
	toolcall_delta: "answer",
	thinking_delta: "thinking",
};

/**
 * A generated-output delta's size and kind, or undefined for any other event.
 * Thinking and tool-call deltas count too: those are generated tokens, so
 * ignoring them would understate reasoning-heavy and tool-calling turns.
 */
export function classifyDelta(
	event: unknown,
): { chars: number; kind: "answer" | "thinking" } | undefined {
	const streamEvent = asRecord(event);
	const kind = typeof streamEvent?.type === "string" ? DELTA_KINDS[streamEvent.type] : undefined;
	if (kind === undefined || typeof streamEvent?.delta !== "string") return undefined;
	const chars = streamEvent.delta.length;
	return chars > 0 ? { chars, kind } : undefined;
}

function seconds(milliseconds: number): number {
	return Math.max(0, milliseconds) / 1000;
}

/** Compact token/rate magnitude: 842, 1.9k, 50k, 1.2M. */
export function compact(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude < 1000) return `${Math.round(value)}`;
	if (magnitude < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (magnitude < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Relative freshness label for the `/throughput` readout. */
export function ageLabel(elapsedMs: number): string {
	if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return "just now";
	const minutes = Math.floor(elapsedMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Footer text: the decode rate alone, prefixed with `~` while estimated. */
export function rateStatusText(tokensPerSecond: number, approximate: boolean): string {
	return `${approximate ? "~" : ""}${Math.max(0, tokensPerSecond).toFixed(1)} tok/s`;
}

/**
 * The client-timed stretch of one message's deltas. The first chunk opens the
 * window, so its characters were generated before it and are not part of the
 * timed span — however many tokens a provider batched into it.
 */
export interface DeltaSpan {
	chars: number;
	firstChunkChars: number;
	seconds: number;
}

/** Share of a span's output generated inside its timed window (0 when nothing was). */
function timedShare(span: DeltaSpan | undefined): number {
	if (span === undefined || span.seconds <= 0 || span.chars <= 0) return 0;
	return Math.max(0, span.chars - span.firstChunkChars) / span.chars;
}

/** Settled-measurement inputs derived from the provider's usage payload. */
export interface SettledMeasurement {
	/** Uncached input tokens; Pi normalizes `usage.input` to uncached input. */
	uncachedInputTokens?: number;
	cacheWriteTokens?: number;
	outputTokens?: number;
	/** Reasoning tokens, already counted in `outputTokens` (Pi's `usage.reasoning`). */
	reasoningTokens?: number;
	/** Every output delta: answer, tool-call, and thinking. */
	all?: DeltaSpan;
	/** Answer deltas only (text and tool calls). */
	answer?: DeltaSpan;
	/** Calibrated characters per token for the live estimate; defaults to 4. */
	charsPerToken?: number;
}

/** A settled decode rate and the token/time sample behind it. */
export interface DecodeRate {
	tokensPerSecond: number;
	approximate: boolean;
	/** Tokens attributed to the timed window. */
	tokens: number;
	seconds: number;
	/** Characters per token the estimate used (estimates only). */
	charsPerToken?: number;
	/** Reasoning tokens left out because they were timed on the answer stream instead. */
	excludedReasoningTokens?: number;
}

/**
 * Rate shown once a message settles.
 *
 * With reported usage the rate is exact. Reasoning tokens are part of the
 * output count, but providers that hide reasoning (or stream only a summary)
 * generate them outside the observed deltas, so dividing them by the delta
 * window would inflate the rate by orders of magnitude. When usage breaks
 * reasoning out, the answer tokens are timed over the answer deltas instead —
 * a valid sample whether the reasoning streamed in full or not.
 *
 * Without usage the rate is a characters-per-token estimate. Without a timed
 * window there is no rate (e.g. a provider that buffers output).
 */
export function decodeRate(input: SettledMeasurement): DecodeRate | undefined {
	const { outputTokens, reasoningTokens } = input;
	if (outputTokens !== undefined) {
		const split = reasoningTokens !== undefined && reasoningTokens > 0;
		const span = split ? input.answer : input.all;
		const tokens = (split ? outputTokens - reasoningTokens : outputTokens) * timedShare(span);
		if (span !== undefined && tokens > 0) {
			return {
				tokensPerSecond: tokens / span.seconds,
				approximate: false,
				tokens,
				seconds: span.seconds,
				...(split ? { excludedReasoningTokens: reasoningTokens } : {}),
			};
		}
	}
	const share = timedShare(input.all);
	if (input.all === undefined || share <= 0) return undefined;
	const charsPerToken = input.charsPerToken ?? CHARS_PER_TOKEN;
	const tokens = (input.all.chars * share) / charsPerToken;
	return {
		tokensPerSecond: tokens / input.all.seconds,
		approximate: true,
		tokens,
		seconds: input.all.seconds,
		charsPerToken,
	};
}

/** Footer text for a settled message, or undefined when nothing was timed. */
export function finalRateText(input: SettledMeasurement): string | undefined {
	const result = decodeRate(input);
	return result && rateStatusText(result.tokensPerSecond, result.approximate);
}

/** Tokens the model actually had to read up front (cache reads excluded). */
export function processedInputTokens(
	input: Pick<SettledMeasurement, "uncachedInputTokens" | "cacheWriteTokens">,
): number {
	return (input.uncachedInputTokens ?? 0) + (input.cacheWriteTokens ?? 0);
}

/** Exact samples smaller than this are too noisy to calibrate chars/token from. */
const MIN_CALIBRATION_TOKENS = 16;
/** Weight kept by older samples each time a new one is folded in. */
const CALIBRATION_DECAY = 0.7;
const MIN_CHARS_PER_TOKEN = 0.5;
const MAX_CHARS_PER_TOKEN = 8;

/**
 * Per-model characters-per-token, learned from settled messages that reported
 * exact usage, so the live `~` estimate converges on the exact rate instead of
 * assuming English prose (code, JSON tool arguments, CJK text, and summarized
 * thinking all tokenize differently).
 */
export class CharsPerTokenCalibration {
	private readonly samples = new Map<string, { chars: number; tokens: number }>();

	/** Learned chars/token for a model, or undefined before the first usable sample. */
	get(key: string): number | undefined {
		const sample = this.samples.get(key);
		if (sample === undefined) return undefined;
		const ratio = sample.chars / sample.tokens;
		return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));
	}

	/** Fold in one settled message's streamed characters and reported tokens. */
	record(key: string, chars: number, tokens: number): void {
		if (!(chars > 0) || !(tokens >= MIN_CALIBRATION_TOKENS)) return;
		const previous = this.samples.get(key);
		this.samples.set(key, {
			chars: (previous?.chars ?? 0) * CALIBRATION_DECAY + chars,
			tokens: (previous?.tokens ?? 0) * CALIBRATION_DECAY + tokens,
		});
	}
}

/** Snapshot of the last settled measurement, rendered by `/throughput`. */
export interface ThroughputRun {
	provider?: string;
	model?: string;
	ttftSeconds?: number;
	uncachedInputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	all?: DeltaSpan;
	answer?: DeltaSpan;
	charsPerToken?: number;
	at: number;
}

/** Detailed single-measurement readout for the `/throughput` command. */
export function runReadout(run: ThroughputRun | undefined, now: number): string {
	if (!run) return "No measurement yet — send a prompt first.";

	const lines = [
		`Live throughput — ${run.provider ?? "unknown"}${run.model ? ` • ${run.model}` : ""}`,
	];

	const prefill: string[] = [];
	if (run.ttftSeconds !== undefined) {
		prefill.push(`TTFT: ${run.ttftSeconds.toFixed(2)}s`);
	}
	const processed = processedInputTokens(run);
	if (processed > 0 && run.ttftSeconds !== undefined && run.ttftSeconds > 0) {
		prefill.push(`Input/TTFT: ~${compact(processed / run.ttftSeconds)} tok/s`);
	}
	lines.push(`• ${prefill.length > 0 ? prefill.join(" · ") : "TTFT: unavailable"}`);

	const uncached = run.uncachedInputTokens ?? 0;
	const cacheWrite = run.cacheWriteTokens ?? 0;
	const cacheRead = run.cacheReadTokens ?? 0;
	if (processed > 0 || cacheRead > 0) {
		const detail: string[] = [];
		if (uncached > 0) detail.push(`${compact(uncached)} uncached`);
		if (cacheWrite > 0) detail.push(`${compact(cacheWrite)} cache write`);
		const suffix: string[] = [];
		if (detail.length > 0) suffix.push(`(${detail.join(" + ")})`);
		if (cacheRead > 0) suffix.push(`· ${compact(cacheRead)} cache read`);
		lines.push(`• input: ${compact(processed)} tok ${suffix.join(" ")}`.trimEnd());
	}

	const result = decodeRate(run);
	if (result !== undefined && !result.approximate) {
		const timed = `${Math.round(result.tokens)} tok timed over ${result.seconds.toFixed(2)}s`;
		lines.push(
			`• decode: ${result.tokensPerSecond.toFixed(1)} tok/s · ${run.outputTokens} output tok · ${timed}`,
		);
		if (result.excludedReasoningTokens !== undefined) {
			lines.push(
				`• reasoning: ${compact(result.excludedReasoningTokens)} tok, excluded — the rate is timed on the answer stream`,
			);
		}
	} else if (run.outputTokens !== undefined) {
		lines.push(`• decode: ${run.outputTokens} tok · rate unavailable`);
	} else if (result !== undefined) {
		const ratio = result.charsPerToken ?? CHARS_PER_TOKEN;
		const basis =
			run.charsPerToken === undefined
				? `chars/${CHARS_PER_TOKEN} estimate`
				: `${ratio.toFixed(1)} chars/tok, calibrated`;
		lines.push(
			`• decode: ~${result.tokensPerSecond.toFixed(1)} tok/s · ~${Math.round(result.tokens)} tok timed (${basis})`,
		);
	} else {
		lines.push("• decode: no output tokens");
	}

	lines.push(`Measured ${ageLabel(now - run.at)}`);
	return lines.join("\n");
}

/** Minimal UI surface shared by event and command contexts. */
interface StatusCtx {
	hasUI?: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		theme?: { fg(color: string, text: string): string };
	};
}

function accent(ui: StatusCtx["ui"], text: string): string {
	try {
		return ui.theme?.fg("accent", text) ?? text;
	} catch {
		return text;
	}
}

/** Active model label, read defensively: it is display-only metadata. */
function modelLabel(ctx: ExtensionContext): { provider?: string; model?: string } {
	const model = asRecord(ctx.model);
	return {
		provider: typeof model?.provider === "string" ? model.provider : undefined,
		model: typeof model?.id === "string" ? model.id : undefined,
	};
}

/** State projected onto the bare-`/throughput` menu screens. */
interface ThroughputMenuState {
	mode: ThroughputMode;
	summary: string;
	readout: string;
}

/** One-line status for the menu: model, measured rate, and freshness. */
function summarizeLastRun(run: ThroughputRun | undefined): string {
	if (!run) return "No measurement yet — send a prompt first.";
	const model = run.provider
		? `${run.provider}${run.model ? ` • ${run.model}` : ""}`
		: "unknown model";
	return `${model} · ${finalRateText(run) ?? "rate unavailable"} · measured ${ageLabel(Date.now() - run.at)}`;
}

/** Accumulates one kind of delta into a span as it streams. */
class SpanTracker {
	firstAt: number | undefined;
	lastAt: number | undefined;
	chars = 0;
	firstChunkChars = 0;

	add(chars: number, at: number): void {
		if (this.firstAt === undefined) {
			this.firstAt = at;
			this.firstChunkChars = chars;
		}
		this.lastAt = at;
		this.chars += chars;
	}

	/** The settled span, or undefined when nothing streamed. */
	span(): DeltaSpan | undefined {
		if (this.firstAt === undefined || this.lastAt === undefined) return undefined;
		return {
			chars: this.chars,
			firstChunkChars: this.firstChunkChars,
			seconds: seconds(this.lastAt - this.firstAt),
		};
	}
}

/**
 * @param clock Monotonic milliseconds for interval timing; wall-clock time
 *   can jump (NTP, sleep) mid-stream. Injectable for tests.
 */
export default function registerLiveThroughput(
	pi: ExtensionAPI,
	clock: () => number = () => performance.now(),
): void {
	let mode: ThroughputMode = loadPrefs(PREFS_FILE, normalizePrefs).mode;
	const calibration = new CharsPerTokenCalibration();

	// Per-message measurement state.
	let requestStartedAt: number | undefined;
	let ttftSeconds: number | undefined;
	let all = new SpanTracker();
	let answer = new SpanTracker();
	let lastDisplayAt = 0;
	let startedLabel: { provider?: string; model?: string } = {};
	let lastRun: ThroughputRun | undefined;

	function enabled(): boolean {
		return mode === "on";
	}

	function calibrationKey(label: { provider?: string; model?: string }): string {
		return `${label.provider ?? ""}/${label.model ?? ""}`;
	}

	function render(ctx: StatusCtx, text: string | undefined): void {
		// Print/JSON modes have no UI: setStatus is a no-op there.
		if (ctx.hasUI === false) return;
		try {
			ctx.ui.setStatus(
				STATUS_KEY,
				text === undefined ? undefined : accent(ctx.ui, `${LABEL} ${text}`),
			);
		} catch {
			// The session can be replaced between an event and this write.
		}
	}

	function resetMeasurement(): void {
		all = new SpanTracker();
		answer = new SpanTracker();
		ttftSeconds = undefined;
		lastDisplayAt = 0;
	}

	function clearMeasurement(): void {
		resetMeasurement();
		requestStartedAt = undefined;
		startedLabel = {};
	}

	pi.on("session_start", async (_event, ctx) => {
		clearMeasurement();
		lastRun = undefined;
		// Clear any line left by an earlier session; while hidden, write nothing.
		if (enabled()) render(ctx, undefined);
	});

	pi.on("model_select", async (_event, ctx) => {
		// A different model has different throughput; drop the stale rate.
		clearMeasurement();
		if (enabled()) render(ctx, undefined);
	});

	// Fires immediately before Pi sends a provider payload. This handler
	// observes time only and deliberately returns no payload rewrite.
	pi.on("before_provider_request", async (_event, _ctx) => {
		if (!enabled()) return;
		requestStartedAt = clock();
	});

	pi.on("message_start", async (event, ctx) => {
		if (!enabled()) return;
		if (event.message.role !== "assistant") return;
		// Keep `requestStartedAt`: the request hook that opened this turn is the
		// real TTFT start. The fallback covers providers that do not emit it.
		resetMeasurement();
		startedLabel = modelLabel(ctx);
		requestStartedAt ??= clock();
		// Deliberately no placeholder line: the footer keeps showing the previous
		// rate until a fresh one is measurable.
	});

	pi.on("message_update", async (event, ctx) => {
		if (!enabled()) return;
		if (event.message.role !== "assistant") return;
		const delta = classifyDelta(event.assistantMessageEvent);
		if (delta === undefined) return;

		const now = clock();
		if (all.firstAt === undefined) {
			ttftSeconds = seconds(now - (requestStartedAt ?? now));
		}
		all.add(delta.chars, now);
		if (delta.kind === "answer") answer.add(delta.chars, now);

		// No rate is meaningful before a real decode window exists, and chunks
		// arrive far faster than the TUI needs to repaint; both guards keep the
		// footer to one honest write per window.
		const span = all.span();
		if (span === undefined || span.seconds < MIN_LIVE_RATE_SECONDS) return;
		if (now - lastDisplayAt < UPDATE_INTERVAL_MS) return;
		lastDisplayAt = now;
		const live = decodeRate({
			all: span,
			charsPerToken: calibration.get(calibrationKey(startedLabel)),
		});
		if (live !== undefined) render(ctx, rateStatusText(live.tokensPerSecond, true));
	});

	pi.on("message_end", async (event, ctx) => {
		if (!enabled()) return;
		if (event.message.role !== "assistant") return;

		const usage = asRecord(asRecord(event.message)?.usage);
		const uncachedInputTokens = positiveNumber(usage?.input);
		// Pi normalizes usage.input to uncached input, so cache writes are the
		// only other tokens the model had to process up front.
		const cacheWriteTokens = positiveNumber(usage?.cacheWrite) ?? 0;
		const cacheReadTokens = positiveNumber(usage?.cacheRead);
		const outputTokens = positiveNumber(usage?.output);
		// A subset of output; only meaningful when it leaves answer tokens over.
		const reportedReasoning = positiveNumber(usage?.reasoning);
		const reasoningTokens =
			reportedReasoning !== undefined &&
			outputTokens !== undefined &&
			reportedReasoning < outputTokens
				? reportedReasoning
				: undefined;

		const allSpan = all.span();
		const answerSpan = answer.span();

		// A message Pi finalized without any observed stream or usage (for
		// example a restored transcript entry) measured nothing; keep the
		// previous line rather than replacing it with an empty one.
		if (ttftSeconds === undefined && outputTokens === undefined && allSpan === undefined) {
			return;
		}

		const key = calibrationKey(startedLabel);
		const measurement: SettledMeasurement = {
			uncachedInputTokens,
			cacheWriteTokens,
			outputTokens,
			reasoningTokens,
			all: allSpan,
			answer: answerSpan,
			charsPerToken: calibration.get(key),
		};
		const result = decodeRate(measurement);
		// A provider that streamed no deltas (or reported no usage) has no rate to
		// show; the previous line stands rather than flickering away.
		if (result !== undefined)
			render(ctx, rateStatusText(result.tokensPerSecond, result.approximate));
		if (result !== undefined && !result.approximate && outputTokens !== undefined) {
			// Learn chars/token from the same sample the exact rate used.
			if (reasoningTokens !== undefined) {
				calibration.record(key, answerSpan?.chars ?? 0, outputTokens - reasoningTokens);
			} else {
				calibration.record(key, allSpan?.chars ?? 0, outputTokens);
			}
		}
		lastRun = {
			...startedLabel,
			...measurement,
			ttftSeconds,
			cacheReadTokens,
			at: Date.now(),
		};
		requestStartedAt = undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearMeasurement();
		if (enabled()) render(ctx, undefined);
	});

	async function handleToggle(rest: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = rest.trim();
		const parsed = parseMode(arg, THROUGHPUT_MODES);
		if (arg.length > 0 && !parsed) {
			ctx.ui.notify(unknownMode(arg, THROUGHPUT_MODES), "warning");
			return;
		}
		const next = parsed ?? cycleMode(mode, THROUGHPUT_MODES);

		mode = next;
		await savePrefs(PREFS_FILE, { mode }, "[live-throughput]");

		if (next === "off") {
			clearMeasurement();
			render(ctx, undefined);
			ctx.ui.notify("Live throughput hidden (/throughput toggle on restores it)", "info");
			return;
		}
		ctx.ui.notify("Live throughput shown", "info");
	}

	/** Bare `/throughput`: the /goal-style menu with the readout and settings. */
	async function showThroughputMenu(ctx: ExtensionCommandContext): Promise<void> {
		await showExtensionMenu<ThroughputMenuState, "main" | "settings" | "details", "set-mode">(
			ctx,
			(kit) =>
				kit.defineMenu<ThroughputMenuState, "main" | "settings" | "details", "set-mode">({
					start: "main",
					screens: {
						main: ({ state }) => ({
							kind: "actions",
							title: "Live throughput",
							lines: [`Footer line: ${state.mode === "on" ? "shown" : "hidden"}`, state.summary],
							items: [
								{
									id: "details",
									label: "Last measurement",
									description: state.summary,
									to: "details",
								},
								{ id: "settings", label: "Settings", to: "settings" },
								{ id: "close", label: "Close", close: true },
							],
							hint: "close",
						}),
						settings: ({ state }) => ({
							kind: "settings",
							title: "Live throughput settings",
							lines: [`Preferences · ${agentFilePath(PREFS_FILE)}`],
							items: [
								{
									id: "mode",
									label: "Footer line",
									description: "Show the live tokens-per-second line in Pi's status area.",
									currentValue: state.mode === "on" ? "On" : "Off",
									values: ["On", "Off"],
									action: "set-mode",
								},
							],
						}),
						details: ({ state }) => ({
							kind: "detail",
							title: "Live throughput — last measurement",
							lines: state.readout.split("\n"),
							hint: "back",
						}),
					},
					actions: {
						"set-mode": async ({ value, ctx: menuCtx }) => {
							if (value === "On" || value === "Off") {
								await handleToggle(value.toLowerCase(), menuCtx);
							}
							return { kind: "stay" };
						},
					},
				}),
			{
				getState: () => ({
					mode,
					summary: summarizeLastRun(lastRun),
					readout: runReadout(lastRun, Date.now()),
				}),
			},
		);
	}

	pi.registerCommand("throughput", {
		description: "Show streaming throughput (/throughput | toggle [on|off] | help)",
		getArgumentCompletions: (prefix) => argumentCompletions(THROUGHPUT_SPECS, prefix),
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);

			switch (sub) {
				case "":
					if (menuSupported(ctx)) {
						await showThroughputMenu(ctx);
						return;
					}
					break;
				case "toggle":
					await handleToggle(rest, ctx);
					return;
				case "help":
					await showHelp(
						ctx,
						commandHelp({
							title: "Live throughput",
							command: "/throughput",
							specs: THROUGHPUT_SPECS,
							sections: [{ heading: "Settings", lines: [`mode: ${mode}`] }],
						}),
					);
					return;
				default:
					ctx.ui.notify(unknownSubcommand("/throughput", sub, THROUGHPUT_SPECS), "warning");
					return;
			}

			const hidden = mode === "off" ? "\n(Footer hidden — /throughput toggle on to show it)" : "";
			ctx.ui.notify(runReadout(lastRun, Date.now()) + hidden, "info");
		},
	});
}
