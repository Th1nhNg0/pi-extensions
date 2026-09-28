/**
 * Live throughput status extension.
 *
 * Adds a model-neutral streaming-throughput line to Pi's footer status area,
 * directly below the model/thinking indicator and the subscription-usage line:
 *
 *   ⚡ ~42.1 tok/s        ← during a stream (characters / 4 estimate)
 *   ⚡ 39.8 tok/s         ← once the message settles (reported output tokens)
 *
 * The footer carries one number only: decode throughput. Live TPS is a
 * `characters / 4` estimate — hence the `~` — because most providers do not
 * report a cumulative token count on every stream chunk. The `~` disappears
 * when the provider reports token usage on `message_end`: the reported
 * output-token count is then spread over the client-observed first-to-last
 * delta interval, with the first token excluded because it defines the start
 * boundary. A provider that streams no deltas, or reports no usage, has no
 * rate to show and simply leaves the most recent one in place.
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
 * shows the last measurement, `/throughput toggle [on|off]` hides or reveals
 * the line, and the choice persists in
 * the Pi agent directory (`~/.pi/agent` by default; honors `PI_CODING_AGENT_DIR`).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
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

/**
 * Characters carried by one streaming delta. Thinking and tool-call deltas
 * count too: those are generated tokens, so ignoring them would understate
 * reasoning-heavy and tool-calling turns.
 */
export function deltaChars(event: unknown): number {
	const streamEvent = asRecord(event);
	if (streamEvent === undefined) return 0;
	if (
		streamEvent.type !== "text_delta" &&
		streamEvent.type !== "thinking_delta" &&
		streamEvent.type !== "toolcall_delta"
	) {
		return 0;
	}
	return typeof streamEvent.delta === "string" ? streamEvent.delta.length : 0;
}

function seconds(milliseconds: number): number {
	return Math.max(0, milliseconds) / 1000;
}

function rate(value: number, durationSeconds: number): string {
	return (value / Math.max(0.001, durationSeconds)).toFixed(1);
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

/** Settled-measurement inputs derived from the provider's usage payload. */
export interface SettledMeasurement {
	/** Uncached input tokens; Pi normalizes `usage.input` to uncached input. */
	uncachedInputTokens?: number;
	cacheWriteTokens?: number;
	outputTokens?: number;
	/** Client-observed first-to-last output delta span, in seconds. */
	decodeSeconds?: number;
	streamedChars: number;
}

/** Tokens the model actually had to read up front (cache reads excluded). */
export function processedInputTokens(
	input: Pick<SettledMeasurement, "uncachedInputTokens" | "cacheWriteTokens">,
): number {
	return (input.uncachedInputTokens ?? 0) + (input.cacheWriteTokens ?? 0);
}

/**
 * Rate shown once a message settles: exact when the provider reported usage,
 * the chars/4 estimate when it streamed without usage, and nothing at all when
 * there was no client-timed decode window (e.g. a provider that buffers output
 * and emits no deltas).
 */
export function finalRateText(input: SettledMeasurement): string | undefined {
	const { outputTokens, decodeSeconds, streamedChars } = input;
	if (
		outputTokens !== undefined &&
		outputTokens > 1 &&
		decodeSeconds !== undefined &&
		decodeSeconds > 0
	) {
		// The first token defines the start boundary, so it is not part of the
		// decoded span; counting it would inflate short responses the most.
		return rateStatusText((outputTokens - 1) / decodeSeconds, false);
	}
	if (streamedChars > 0 && decodeSeconds !== undefined && decodeSeconds > 0) {
		return rateStatusText(streamedChars / CHARS_PER_TOKEN / decodeSeconds, true);
	}
	return undefined;
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
	decodeSeconds?: number;
	streamedChars: number;
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

	if (
		run.outputTokens !== undefined &&
		run.outputTokens > 1 &&
		run.decodeSeconds !== undefined &&
		run.decodeSeconds > 0
	) {
		lines.push(
			`• decode: ${rate(run.outputTokens - 1, run.decodeSeconds)} tok/s · ${run.outputTokens} tok over ${run.decodeSeconds.toFixed(2)}s`,
		);
	} else if (run.outputTokens !== undefined) {
		lines.push(`• decode: ${run.outputTokens} tok · rate unavailable`);
	} else if (run.streamedChars > 0 && run.decodeSeconds !== undefined && run.decodeSeconds > 0) {
		const estimatedTokens = run.streamedChars / CHARS_PER_TOKEN;
		lines.push(
			`• decode: ~${rate(estimatedTokens, run.decodeSeconds)} tok/s · ~${Math.round(estimatedTokens)} tok (chars/4 estimate)`,
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

export default function registerLiveThroughput(pi: ExtensionAPI): void {
	let mode: ThroughputMode = loadPrefs(PREFS_FILE, normalizePrefs).mode;

	// Per-message measurement state.
	let requestStartedAt: number | undefined;
	let firstOutputAt: number | undefined;
	let lastOutputAt: number | undefined;
	let ttftSeconds: number | undefined;
	let streamedChars = 0;
	let lastDisplayAt = 0;
	let startedLabel: { provider?: string; model?: string } = {};
	let lastRun: ThroughputRun | undefined;

	function enabled(): boolean {
		return mode === "on";
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
		firstOutputAt = undefined;
		lastOutputAt = undefined;
		ttftSeconds = undefined;
		streamedChars = 0;
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
		requestStartedAt = Date.now();
	});

	pi.on("message_start", async (event, ctx) => {
		if (!enabled()) return;
		if (event.message.role !== "assistant") return;
		// Keep `requestStartedAt`: the request hook that opened this turn is the
		// real TTFT start. The fallback covers providers that do not emit it.
		resetMeasurement();
		startedLabel = modelLabel(ctx);
		requestStartedAt ??= Date.now();
		// Deliberately no placeholder line: the footer keeps showing the previous
		// rate until a fresh one is measurable.
	});

	pi.on("message_update", async (event, ctx) => {
		if (!enabled()) return;
		if (event.message.role !== "assistant") return;
		const chars = deltaChars(event.assistantMessageEvent);
		if (chars <= 0) return;

		const now = Date.now();
		if (firstOutputAt === undefined) {
			firstOutputAt = now;
			ttftSeconds = seconds(now - (requestStartedAt ?? now));
		}
		lastOutputAt = now;
		streamedChars += chars;

		// No rate is meaningful before a real decode window exists, and chunks
		// arrive far faster than the TUI needs to repaint; both guards keep the
		// footer to one honest write per window.
		const decodeSeconds = seconds(now - firstOutputAt);
		if (decodeSeconds < MIN_LIVE_RATE_SECONDS) return;
		if (now - lastDisplayAt < UPDATE_INTERVAL_MS) return;
		lastDisplayAt = now;
		render(ctx, rateStatusText(streamedChars / CHARS_PER_TOKEN / decodeSeconds, true));
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

		const observedTtft = ttftSeconds;
		const decodeSeconds =
			firstOutputAt !== undefined && lastOutputAt !== undefined
				? seconds(lastOutputAt - firstOutputAt)
				: undefined;

		// A message Pi finalized without any observed stream or usage (for
		// example a restored transcript entry) measured nothing; keep the
		// previous line rather than replacing it with an empty one.
		if (observedTtft === undefined && outputTokens === undefined && streamedChars === 0) {
			return;
		}

		const rateText = finalRateText({
			uncachedInputTokens,
			cacheWriteTokens,
			outputTokens,
			decodeSeconds,
			streamedChars,
		});
		// A provider that streamed no deltas (or reported no usage) has no rate to
		// show; the previous line stands rather than flickering away.
		if (rateText !== undefined) render(ctx, rateText);
		lastRun = {
			...startedLabel,
			ttftSeconds: observedTtft,
			uncachedInputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			outputTokens,
			decodeSeconds,
			streamedChars,
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

	pi.registerCommand("throughput", {
		description: "Show streaming throughput (/throughput | toggle [on|off] | help)",
		getArgumentCompletions: (prefix) => argumentCompletions(THROUGHPUT_SPECS, prefix),
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);

			switch (sub) {
				case "":
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
