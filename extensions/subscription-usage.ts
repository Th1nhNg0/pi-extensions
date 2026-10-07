/**
 * Subscription usage extension.
 *
 * Shows usage for the active subscription-backed provider as a minimal
 * footer status line, directly below pi's model/thinking indicator (the
 * footer already names the provider, so no prefix is repeated):
 *
 *   ↑1k ↓2k $0.123 12.5%/200k (auto)      kimi-k2 • high
 *   R: ░░░░░░ 4% ~4h · W: ██████ 97% ~8h · M: █████░░░ 62% ~20d
 *   Peak ~2h · R: ░░░░░░ 4% ~4h                  ← DeepSeek peak hours
 *   5h: ░░░░░░ 1% ~4h · W: ░░░░░░ 0% ~6d
 *   Off-Peak ~5h · $12.34                        ← DeepSeek API balance
 *
 * `/usage` shows the detailed readout for logged-in providers; in interactive
 * sessions bare `/usage` opens the same TUI settings menu as `/goal`.
 * `/usage toggle [bars|percent|off]` cycles bars → bare percentages →
 * hidden (or jumps straight to the given mode); the choice persists in the
 * Pi agent directory (`~/.pi/agent` by default; honors `PI_CODING_AGENT_DIR`).
 *
 * `/usage refresh [all|<provider>|active]` force-refetches every usage
 * provider (the default) or just one, bypassing the cooldown guards.
 *
 * Each window also shows a compact countdown (~) until it resets. OpenCode
 * reports `resetsAt` (ISO) per window; Codex reports `reset_at` (epoch s);
 * Antigravity reports `resetTime` (ISO) per bucket. DeepSeek bills on two UTC
 * peak windows, UTC weekdays only (01:00–04:00 and 06:00–10:00 UTC), rendered in
 * local time, and the DeepSeek API provider additionally shows the account
 * balance from `GET /user/balance`.
 *
 * Fetch strategy (adaptive, no spam):
 * - Fetch on session start, model switch, and right after an agent turn
 *   settles (agent_settled), gated by a 60s cooldown unless a usage window
 *   is about to flip.
 * - Idle scheduling is reset-aware: it wakes shortly after a usage window
 *   resets so fresh pools show up promptly, backs off exponentially
 *   (20s → 30min) on API failures, and jitters ±20% so timers don't sync
 *   across sessions.
 *
 * API keys resolve from env first, then stored credentials in auth.json.
 * The Codex endpoint requires a browser User-Agent to pass Cloudflare.
 */

import fs from "node:fs";
import { asRecord } from "./shared/record-guards.ts";
import {
	getCacheFile,
	loadDiskCache,
	normalizeUsageData,
	saveDiskCache,
} from "./subscription/usage-cache.ts";
import type { UsageBalance, UsageData } from "./subscription/usage-cache.ts";
export { normalizeUsageData };
export type { UsageBalance, UsageData };
import { codexCfg, codexWindowKey, parseCodexUsage } from "./subscription/codex-usage.ts";
import type { CodexUsageResponse, RateLimitWindowSnapshot } from "./subscription/codex-usage.ts";
export { codexCfg, codexWindowKey, parseCodexUsage };
export type { CodexUsageResponse, RateLimitWindowSnapshot };
import { COOLDOWN_MS, MIN_FETCH_GAP_MS, nextDelay } from "./subscription/refresh-schedule.ts";
import { antigravityCfg, antigravityEndpointCandidates } from "./subscription/antigravity-quota.ts";
import { opencodeCfg } from "./subscription/opencode-usage.ts";
import { deepseekCfg } from "./subscription/deepseek-usage.ts";
import { formatBalance } from "./subscription/balance.ts";
import type {
	LinkedProviderCfg,
	PolledProviderCfg,
	ProviderCfg,
} from "./subscription/provider-config.ts";
export { antigravityCfg, antigravityEndpointCandidates, deepseekCfg, formatBalance, opencodeCfg };
import { MissingCredentialError, hasUsageCredential } from "./subscription/credentials.ts";
export { MissingCredentialError };
import {
	bar,
	detailBar,
	fetchAgeLabel,
	formatUsageDetails,
	windowSegment,
} from "./subscription/rendering.ts";
import type { UsageStyle } from "./subscription/rendering.ts";
export { bar, detailBar, fetchAgeLabel, formatUsageDetails, windowSegment };
export type { UsageStyle };
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	agentFilePath,
	argumentCompletions,
	commandHelp,
	cycleMode,
	loadPrefs,
	parseMode,
	parseSubcommand,
	usageLine,
	savePrefs,
	showHelp,
	unknownMode,
	unknownSubcommand,
	type CommandSpec,
} from "./shared/command-kit.ts";
import { menuSupported, showExtensionMenu } from "./shared/settings-menu.ts";
import {
	formatRefreshNotice,
	resolveRefreshTargets as resolveRefreshTargetsImpl,
} from "./subscription/refresh-command.ts";
import type { RefreshOutcome, RefreshResult } from "./subscription/refresh-command.ts";
export { formatRefreshNotice };
export type { RefreshOutcome, RefreshResult };

import {
	DEEPSEEK_PEAK_WINDOWS,
	deepSeekPeakTag,
	earliestReset,
	formatDeepSeekPeakWindows,
	formatLocalTimeRange,
	getDeepSeekPeakInfo,
	isDeepSeekPeakDay,
	resetLabel,
	usesDeepSeekPeakPricing,
} from "./subscription/usage-windows.ts";
export {
	DEEPSEEK_PEAK_WINDOWS,
	deepSeekPeakTag,
	earliestReset,
	formatDeepSeekPeakWindows,
	formatLocalTimeRange,
	getDeepSeekPeakInfo,
	isDeepSeekPeakDay,
	resetLabel,
	usesDeepSeekPeakPricing,
};
export type { DeepSeekPeakInfo } from "./subscription/usage-windows.ts";

const PREFS_FILE = "subscription-usage-prefs.json";

/** Display style for usage windows: bar cells or bare percentages. */

export const USAGE_STYLES: readonly UsageStyle[] = ["bars", "percent"];

/** Toggle states: both display styles plus fully hidden ("off"). */
export type UsageMode = UsageStyle | "off";

export const USAGE_MODES: readonly UsageMode[] = ["bars", "percent", "off"];

/** One table drives the help, the completions, and the unknown-subcommand message. */
export const USAGE_SPECS: readonly CommandSpec[] = [
	{ name: "", description: "detailed usage for logged-in providers" },
	{
		name: "toggle",
		values: USAGE_MODES,
		description: "cycle the footer style: bars → percent → off",
	},
	{
		name: "refresh",
		hint: "[all|<provider>|active]",
		description: "force-refresh providers (default: every one)",
	},
	{ name: "help", description: "show this help" },
];

export function normalizeUsageStyle(value: unknown): UsageStyle | undefined {
	return typeof value === "string" && (USAGE_STYLES as string[]).includes(value)
		? (value as UsageStyle)
		: undefined;
}

export function normalizeUsageMode(value: unknown): UsageMode | undefined {
	return typeof value === "string" && (USAGE_MODES as string[]).includes(value)
		? (value as UsageMode)
		: undefined;
}

export interface UsagePrefs {
	mode: UsageMode;
}

/** Validate a parsed prefs file, falling back to defaults on anything odd. */
export function normalizePrefs(value: unknown): UsagePrefs {
	const record = asRecord(value);
	return {
		mode:
			normalizeUsageMode(record?.mode) ??
			// Legacy pref files wrote { style } before the cycle toggle existed.
			normalizeUsageStyle(record?.style) ??
			"bars",
	};
}

export const openaiCfg: LinkedProviderCfg = {
	id: "openai",
	usageLink: "https://chatgpt.com/settings/usage",
};

interface StatusCtx {
	model?: { provider?: string; id?: string };
	ui: {
		setStatus(key: string, text: string | undefined): void;
		theme: { fg(color: string, text: string): string };
	};
}

/** Per-provider scheduler state: timers, backoff counter, cached results. */
interface ProviderState {
	lastFetch: number; // when we last successfully retrieved fresh data from API/cache
	lastAttempt: number; // when we last attempted a fetch
	lastText: string | undefined;
	lastData: UsageData | undefined; // last successful payload (reset times)
	failStreak: number; // consecutive failures → exponential backoff
	timer: ReturnType<typeof setTimeout> | undefined;
	timerDeadline?: number;
	inFlight: Promise<RefreshOutcome> | undefined;
	requestId: number;
	abortController?: AbortController;
}

export function cap(s: string): string {
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Every usage provider this extension supports, in display order. `/usage
 * refresh` fans out over this list unless a narrower target is given.
 */
export const usageProviderCfgs: readonly ProviderCfg[] = [
	opencodeCfg,
	openaiCfg,
	codexCfg,
	antigravityCfg,
	deepseekCfg,
];

/** Resolve a `/usage refresh` target against this extension's provider configs. */
export function resolveRefreshTargets(
	arg: string,
	cfgs: readonly ProviderCfg[],
	activeProviderId?: string,
): ProviderCfg[] | undefined {
	return resolveRefreshTargetsImpl(arg, cfgs, activeProviderId);
}

/** State projected onto the bare-`/usage` menu screens. */
interface UsageMenuState {
	mode: UsageMode;
	detail: string;
	providers: string;
	active: string;
}

/** Title-case footer style for the settings row. */
function formatUsageMode(mode: UsageMode): string {
	if (mode === "bars") return "Bars";
	return mode === "percent" ? "Percent" : "Off";
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, ProviderState>();
	let currentCtx: StatusCtx | undefined;
	const cfgs = usageProviderCfgs;
	let mode: UsageMode = loadPrefs(PREFS_FILE, normalizePrefs).mode;

	function renderUi(
		ui: StatusCtx["ui"] | undefined,
		providerId: string,
		text: string | undefined,
	): void {
		if (!ui) return;
		// The footer status line belongs to the active provider only: a fan-out
		// refresh must not leave widgets behind for providers we are not using.
		if (text !== undefined) {
			const activeProvider = currentCtx ? safeModel(currentCtx)?.provider : undefined;
			if (activeProvider !== providerId) return;
		}
		try {
			// Footer status line, directly below the model/thinking indicator.
			ui.setStatus(providerId, text);
		} catch {
			// The session can be replaced between safeUi() and this write.
		}
	}

	/** Render `data` for a provider in the current style. */
	function renderText(
		cfg: PolledProviderCfg,
		data: UsageData,
		ui: StatusCtx["ui"],
		modelId?: string,
	): string {
		if (mode === "off") return "";
		return cfg.render(data, ui.theme, modelId, mode) || `${cfg.id}: no data`;
	}

	function freshState(): ProviderState {
		return {
			lastFetch: 0,
			lastAttempt: 0,
			lastText: undefined,
			lastData: undefined,
			failStreak: 0,
			timer: undefined,
			timerDeadline: undefined,
			inFlight: undefined,
			requestId: 0,
			abortController: undefined,
		};
	}

	let cacheSyncTimer: ReturnType<typeof setTimeout> | undefined;
	let cacheWatcherActive = false;

	async function syncFromDisk(): Promise<void> {
		const ctx = currentCtx;
		if (!ctx || mode === "off") return;
		const ui = safeUi(ctx);
		if (!ui) return;
		const model = safeModel(ctx);
		const activeProvider = model?.provider;
		if (!activeProvider) return;
		const cfg = cfgs.find((c) => c.id === activeProvider);
		if (!cfg || "usageLink" in cfg) return;

		const state = cache.get(cfg.id);
		if (!state) return;
		const requestId = state.requestId;
		const disk = (await loadDiskCache())[cfg.id];
		// A delayed disk read must not revive a cleared provider or overwrite
		// a newer request after a model switch, hide, or session shutdown.
		if (cache.get(cfg.id) !== state || state.requestId !== requestId) return;
		if (!disk?.data || !Number.isFinite(disk.fetchedAt)) return;
		if (disk.fetchedAt > state.lastFetch) {
			state.lastFetch = disk.fetchedAt;
			state.lastData = disk.data;
			state.failStreak = 0;
			cache.set(cfg.id, state);
			state.lastText = renderText(cfg, disk.data, ui, model?.id);
			renderUi(ui, cfg.id, state.lastText);
			arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
		}
	}

	function scheduleDiskSync(): void {
		if (cacheSyncTimer) return;
		cacheSyncTimer = setTimeout(() => {
			cacheSyncTimer = undefined;
			void (async () => {
				try {
					await syncFromDisk();
				} catch (error) {
					console.error("[subscription-usage] cache sync failed:", error);
				}
			})();
		}, 100);
		cacheSyncTimer.unref?.();
	}

	function onDiskCacheChange(curr: fs.Stats, prev: fs.Stats): void {
		if (curr.mtimeMs !== prev.mtimeMs) scheduleDiskSync();
	}

	function startDiskCacheWatcher(): void {
		if (cacheWatcherActive) return;
		try {
			fs.watchFile(getCacheFile(), { interval: 1000, persistent: false }, onDiskCacheChange);
			cacheWatcherActive = true;
		} catch {
			// Ignore watch error if the cache path is not accessible yet.
		}
	}

	function stopDiskCacheWatcher(): void {
		if (!cacheWatcherActive) return;
		try {
			fs.unwatchFile(getCacheFile(), onDiskCacheChange);
		} catch {
			// Ignore unwatch failure during shutdown.
		}
		cacheWatcherActive = false;
		if (cacheSyncTimer) clearTimeout(cacheSyncTimer);
		cacheSyncTimer = undefined;
	}

	/**
	 * Return ctx.ui, or undefined when the session ctx is stale — i.e. the
	 * session was replaced or reloaded while we were awaiting a fetch. UI
	 * writes are dropped silently in that case instead of throwing the
	 * "extension ctx is stale" error (which used to escape as an
	 * uncaughtException and kill pi).
	 */
	function safeUi(ctx: StatusCtx): StatusCtx["ui"] | undefined {
		try {
			const ui = ctx.ui;
			void ui.theme;
			return ui;
		} catch {
			return undefined;
		}
	}

	function safeModel(ctx: StatusCtx): StatusCtx["model"] | undefined {
		try {
			const model = ctx.model;
			if (model) {
				void model.provider;
				void model.id;
			}
			return model;
		} catch {
			return undefined;
		}
	}

	interface RefreshOptions {
		/** Skip the event cooldown (session start, model switch, manual refresh). */
		force?: boolean;
		/** Also skip the MIN_FETCH_GAP_MS burst guard and replace an in-flight
		 *  request, so a manual /usage refresh always performs a live request. */
		hard?: boolean;
		/** A timer wake: its delay already encodes the cooldown/backoff policy. */
		scheduled?: boolean;
	}

	async function refresh(
		cfg: ProviderCfg,
		ctx: StatusCtx,
		{ force = false, hard = false, scheduled = false }: RefreshOptions = {},
	): Promise<RefreshOutcome> {
		if ("usageLink" in cfg) {
			const available = hasUsageCredential(cfg.id);
			// Never substitute legacy Codex quotas or an informational footer.
			renderUi(safeUi(ctx), cfg.id, undefined);
			return available ? "unsupported" : "skipped";
		}
		const state = cache.get(cfg.id) ?? freshState();
		cache.set(cfg.id, state);
		if (state.inFlight && !hard) return state.inFlight;
		const requestId = state.requestId + 1;
		state.requestId = requestId;
		const isCurrentRequest = (): boolean =>
			cache.get(cfg.id) === state && state.requestId === requestId;

		state.abortController?.abort();
		const ac = new AbortController();
		state.abortController = ac;

		const request = (async (): Promise<RefreshOutcome> => {
			const now = Date.now();
			const model = safeModel(ctx);

			// Sync with disk cache if another session fetched newer data.
			const disk = (await loadDiskCache())[cfg.id];
			if (!isCurrentRequest()) return "cached";
			if (!disk?.data || !Number.isFinite(disk.fetchedAt)) {
				// No usable shared data; continue to the provider request.
			} else if (disk.fetchedAt > state.lastFetch) {
				state.lastFetch = disk.fetchedAt;
				state.lastData = disk.data;
				state.failStreak = 0;
			}

			// Event pokes (agent_settled) skip when we fetched moments ago, or
			// while the API is failing and no reset is about to flip. Forced
			// refetches (session start, model switch) always hit the API.
			const reset = earliestReset(state.lastData, model?.id, cfg.id, now);
			const resetSoon = reset !== undefined && reset - now < COOLDOWN_MS;
			if (
				!force &&
				!scheduled &&
				state.lastText !== undefined &&
				(now - state.lastAttempt < COOLDOWN_MS || (state.failStreak > 0 && !resetSoon))
			) {
				const ui = safeUi(ctx);
				if (ui && state.lastData) {
					state.lastText = renderText(cfg, state.lastData, ui, model?.id);
				}
				renderUi(ui, cfg.id, state.lastText);
				return "cached";
			}

			// Even on forced poke, if disk was updated within MIN_FETCH_GAP_MS
			// (e.g. another session just fetched 2s ago), reuse it to avoid a
			// duplicate burst request. Manual /usage refresh (hard) skips this.
			if (!hard && now - state.lastFetch < MIN_FETCH_GAP_MS && state.lastData) {
				const ui = safeUi(ctx);
				if (ui) {
					state.lastText = renderText(cfg, state.lastData, ui, model?.id);
					renderUi(ui, cfg.id, state.lastText);
				}
				return "cached";
			}

			state.lastAttempt = now;
			try {
				const data = normalizeUsageData(await cfg.fetchUsage(ac.signal));
				if (!data) throw new Error("provider returned no valid usage data");
				const ui = safeUi(ctx);
				if (!ui || !isCurrentRequest()) return "cached";
				state.lastFetch = now;
				state.failStreak = 0;
				state.lastData = data;
				state.lastText = renderText(cfg, data, ui, model?.id);
				renderUi(ui, cfg.id, state.lastText);
				await saveDiskCache(cfg.id, data);
				return "fetched";
			} catch (err) {
				const ui = safeUi(ctx);
				if (!ui || !isCurrentRequest()) return "cached";
				if (err instanceof MissingCredentialError) {
					// No credential for this account: nothing was sent to the API, so
					// this is availability, not failure — no backoff, no error log.
					state.lastText = state.lastData
						? renderText(cfg, state.lastData, ui, model?.id)
						: ui.theme.fg("warning", `${cfg.id}: no key`);
					renderUi(ui, cfg.id, state.lastText);
					return "skipped";
				}
				state.failStreak += 1;
				console.error(
					`[${cfg.id}-usage] fetch failed (${state.failStreak}×): ` +
						(err instanceof Error ? err.message : String(err)),
				);
				if (state.lastData) {
					const base = renderText(cfg, state.lastData, ui, model?.id);
					state.lastText = ui.theme.fg("warning", `${base} ⚠`);
					renderUi(ui, cfg.id, state.lastText);
				} else {
					state.lastText = ui.theme.fg("error", `${cfg.id}: err`);
					renderUi(ui, cfg.id, state.lastText);
				}
				return "failed";
			}
		})();
		state.inFlight = request;
		try {
			return await request;
		} finally {
			if (state.abortController === ac) state.abortController = undefined;
			if (state.inFlight === request) state.inFlight = undefined;
		}
	}

	/** (Re)arm the next scheduled fetch with a delay computed from the last outcome. */
	function arm(cfg: PolledProviderCfg, ctx: StatusCtx, delayMs: number) {
		const state = cache.get(cfg.id) ?? freshState();
		if (state.timer) clearTimeout(state.timer);
		cache.set(cfg.id, state);
		state.timerDeadline = Date.now() + delayMs;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			state.timerDeadline = undefined;
			void (async () => {
				if (!safeUi(ctx) || cache.get(cfg.id) !== state) return;
				await refresh(cfg, ctx, { scheduled: true });
				if (!safeUi(ctx) || cache.get(cfg.id) !== state) return;
				const model = safeModel(ctx);
				arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
			})();
		}, delayMs);
		state.timer.unref?.();
	}

	/** Immediate refresh + rearm from the fresh outcome (used by events). */
	function poke(cfg: PolledProviderCfg, ctx: StatusCtx, force: boolean) {
		void (async () => {
			if (!safeUi(ctx)) return;
			const outcome = await refresh(cfg, ctx, { force });
			const s = cache.get(cfg.id);
			const model = safeModel(ctx);
			if (s && safeUi(ctx)) {
				if (outcome === "fetched" || !s.timer) {
					arm(cfg, ctx, nextDelay(s, Date.now(), model?.id, cfg.id));
				}
			}
		})();
	}

	function clear(ctx: StatusCtx, key: string) {
		const state = cache.get(key);
		if (state?.timer) clearTimeout(state.timer);
		state?.abortController?.abort();
		cache.delete(key);
		renderUi(safeUi(ctx), key, undefined);
	}

	/** Route to the right provider config for the active model. */
	function route(ctx: StatusCtx, force: boolean) {
		currentCtx = ctx;
		if (mode === "off") {
			stopDiskCacheWatcher();
			return;
		}
		const provider = safeModel(ctx)?.provider;
		const active = cfgs.find((c) => c.id === provider);
		for (const c of cfgs) {
			if (c !== active) clear(ctx, c.id);
		}
		if (active && "usageLink" in active) {
			stopDiskCacheWatcher();
			clear(ctx, active.id);
		} else if (active) {
			startDiskCacheWatcher();
			poke(active, ctx, force);
		} else {
			stopDiskCacheWatcher();
		}
	}

	/**
	 * Shared `/usage` subcommand handlers — the single `usage` command
	 * registered below dispatches to these, so every usage control lives
	 * under one `/usage` command (like `/discord`).
	 */
	type UsageCmdCtx = Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1];

	/** `/usage toggle [bars|percent|off]` — cycle the footer style or set it directly. */
	async function handleUsageToggle(args: string, ctx: UsageCmdCtx): Promise<void> {
		const arg = args.trim();
		const parsed = parseMode(arg, USAGE_MODES);
		if (arg.length > 0 && !parsed) {
			ctx.ui.notify(unknownMode(arg, USAGE_MODES), "warning");
			return;
		}
		// Cycle bars → percent → off → bars when no explicit mode is given.
		const next = parsed ?? cycleMode(mode, USAGE_MODES);

		mode = next;
		await savePrefs(PREFS_FILE, { mode }, "[subscription-usage]");

		if (next === "off") {
			stopDiskCacheWatcher();
			// Hide: drop statuses and stop every timer/fetch for this session.
			for (const c of cfgs) clear(ctx, c.id);
			ctx.ui.notify("Subscription usage hidden (/usage toggle restores it)", "info");
			return;
		}

		// Re-render from cached data so the footer updates immediately.
		const model = safeModel(ctx);
		const cfg = cfgs.find((c) => c.id === model?.provider);
		if (cfg && "usageLink" in cfg) {
			route(ctx, true);
			ctx.ui.notify(`Subscription usage style: ${next}`, "info");
			return;
		}
		const ui = safeUi(ctx);
		const state = cfg ? cache.get(cfg.id) : undefined;
		if (cfg && ui && state?.lastData) {
			state.lastText = renderText(cfg, state.lastData, ui, model?.id);
			renderUi(ui, cfg.id, state.lastText);
			// Leaving "off" killed this provider's timer — re-arm it.
			if (!state.timer) arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
		} else if (cfg && ui) {
			// Nothing usable cached (e.g. first reveal after hiding) — fetch now.
			poke(cfg, ctx, true);
		}
		ctx.ui.notify(`Subscription usage style: ${next}`, "info");
	}

	/**
	 * `/usage refresh [all|<provider>|active]` — force a live refetch for every
	 * usage provider (the default), or just the named/active one, bypassing the
	 * cooldown and burst guards. Useful when the source API lags (e.g.
	 * Antigravity quota summary right after a reset) and you want to rule out
	 * client-side staleness in one keystroke.
	 */
	async function handleUsageRefresh(args: string, ctx: UsageCmdCtx): Promise<void> {
		if (mode === "off") {
			ctx.ui.notify("Subscription usage is hidden; use /usage toggle to enable refreshes", "info");
			return;
		}
		const targets = resolveRefreshTargets(args, cfgs, safeModel(ctx)?.provider);
		if (!targets) {
			ctx.ui.notify(
				`Unknown usage provider "${args.trim()}". Known: ${cfgs.map((c) => c.id).join(", ")}` +
					` (or "all"/"active")`,
				"warning",
			);
			return;
		}
		// Settle every target so one slow or failing provider cannot hide the
		// outcome of the others. `refresh()` reports rather than throws.
		const settled = await Promise.allSettled(
			targets.map(
				async (cfg): Promise<RefreshResult> => ({
					id: cfg.id,
					outcome: await refresh(cfg, ctx, { force: true, hard: true }),
				}),
			),
		);
		const results: RefreshResult[] = settled.map((entry, index) =>
			entry.status === "fulfilled"
				? entry.value
				: { id: targets[index].id, outcome: "failed" as const },
		);
		// Only the provider active *now* owns the footer and the wake timer: a
		// fan-out must not leave stale widgets or polling loops behind.
		const current = safeModel(ctx);
		const activeCfg = cfgs.find((c) => c.id === current?.provider);
		const state = activeCfg ? cache.get(activeCfg.id) : undefined;
		if (activeCfg && !("usageLink" in activeCfg) && state && safeUi(ctx))
			arm(activeCfg, ctx, nextDelay(state, Date.now(), current?.id, activeCfg.id));
		ctx.ui.notify(formatRefreshNotice(results), "info");
	}

	/**
	 * One live fetch for the provider active now; the rest render from cache so
	 * one command never fans out to every API. Shared by bare `/usage` and the
	 * menu it opens.
	 */
	async function refreshActiveUsage(ctx: UsageCmdCtx): Promise<void> {
		if (mode === "off") return;
		const model = safeModel(ctx);
		const activeCfg = cfgs
			.filter((cfg) => hasUsageCredential(cfg.id))
			.find((c) => c.id === model?.provider);
		if (!activeCfg || "usageLink" in activeCfg) return;
		try {
			await refresh(activeCfg, ctx, { force: true, hard: true });
		} catch {
			// refresh() already renders footer errors; details fall back to cache below.
		}
		const state = cache.get(activeCfg.id);
		const current = safeModel(ctx);
		if (state && safeUi(ctx))
			arm(activeCfg, ctx, nextDelay(state, Date.now(), current?.id, activeCfg.id));
	}

	/** Detailed readout for every logged-in provider, from cache and disk. */
	async function buildUsageDetails(ctx: UsageCmdCtx): Promise<string> {
		const model = safeModel(ctx);
		const loggedInCfgs = cfgs.filter((cfg) => hasUsageCredential(cfg.id));
		const activeCfg = loggedInCfgs.find((c) => c.id === model?.provider);
		const sections: string[] = [];
		for (const cfg of loggedInCfgs) {
			if ("usageLink" in cfg) {
				sections.push(
					`Subscription usage — ${cfg.id} (ChatGPT plan)\n` +
						`Quota percentages are not available through a documented API.\n` +
						`Manage usage: ${cfg.usageLink}`,
				);
				continue;
			}
			const state = cache.get(cfg.id);
			let data = state?.lastData;
			let fetchedAt = state?.lastFetch;
			if (!data) {
				try {
					const disk = (await loadDiskCache())[cfg.id];
					if (disk?.data) {
						data = disk.data;
						fetchedAt = disk.fetchedAt;
					}
				} catch {
					// Disk cache is best-effort; missing data is reported below.
				}
			}
			const modelId = cfg === activeCfg ? model?.id : undefined;
			sections.push(
				data
					? formatUsageDetails(data, cfg.id, { modelId, fetchedAt, now: Date.now() })
					: `${cfg.id}: no usage data yet`,
			);
		}
		const hiddenHint = mode === "off" ? "\n(Footer hidden — /usage toggle to restore it)" : "";
		return (sections.join("\n\n") || "No subscription providers logged in") + hiddenHint;
	}

	/** Bare `/usage`: the /goal-style menu with the readout and settings. */
	async function showUsageMenu(ctx: UsageCmdCtx): Promise<void> {
		await showExtensionMenu<
			UsageMenuState,
			"main" | "settings" | "details",
			"set-mode" | "refresh"
		>(
			ctx,
			(kit) =>
				kit.defineMenu<UsageMenuState, "main" | "settings" | "details", "set-mode" | "refresh">({
					start: "main",
					screens: {
						main: ({ state }) => ({
							kind: "actions",
							title: "Subscription usage",
							lines: [
								`Footer style: ${formatUsageMode(state.mode)}`,
								`Providers: ${state.providers}`,
								`Active provider: ${state.active}`,
							],
							items: [
								{
									id: "refresh",
									label: "Refresh now",
									description: "Force-refresh every usage provider",
									action: "refresh",
									busyLabel: "Refreshing",
								},
								{ id: "details", label: "Usage details", to: "details" },
								{ id: "settings", label: "Settings", to: "settings" },
								{ id: "close", label: "Close", close: true },
							],
							hint: "close",
						}),
						settings: ({ state }) => ({
							kind: "settings",
							title: "Subscription usage settings",
							lines: [`Preferences · ${agentFilePath(PREFS_FILE)}`],
							items: [
								{
									id: "mode",
									label: "Footer style",
									description: "How usage windows are drawn in Pi's status area.",
									currentValue: formatUsageMode(state.mode),
									values: ["Bars", "Percent", "Off"],
									action: "set-mode",
								},
							],
						}),
						details: ({ state }) => ({
							kind: "detail",
							title: "Subscription usage",
							lines: state.detail.split("\n"),
							hint: "back",
						}),
					},
					actions: {
						"set-mode": async ({ value, ctx: menuCtx }) => {
							const parsed = parseMode(value ?? "", USAGE_MODES);
							if (parsed) await handleUsageToggle(parsed, menuCtx);
							return { kind: "stay" };
						},
						refresh: async ({ ctx: menuCtx }) => {
							await handleUsageRefresh("all", menuCtx);
							return { kind: "stay" };
						},
					},
				}),
			{
				getState: async (menuCtx) => {
					const providers = cfgs.filter((cfg) => hasUsageCredential(cfg.id)).map((cfg) => cfg.id);
					return {
						mode,
						detail: await buildUsageDetails(menuCtx),
						providers: providers.length > 0 ? providers.join(", ") : "none logged in",
						active: safeModel(menuCtx)?.provider ?? "none",
					};
				},
			},
		);
	}

	/**
	 * Single `/usage` command: bare `/usage` opens the settings menu in the TUI
	 * (the detailed readout elsewhere); `/usage toggle [bars|percent|off]` cycles
	 * the footer style; `/usage refresh [all|<provider>|active]` force-refetches
	 * every usage provider (default) or the named/active one.
	 */
	pi.registerCommand("usage", {
		description: `Show subscription usage (${usageLine("/usage", USAGE_SPECS).replace("Usage: ", "")})`,
		getArgumentCompletions: (prefix) =>
			argumentCompletions(USAGE_SPECS, prefix, (sub) =>
				sub === "refresh"
					? [
							{
								value: "refresh all",
								label: "refresh all",
								description: "Force-refresh every usage provider",
							},
							{
								value: "refresh active",
								label: "refresh active",
								description: "Force-refresh the active provider only",
							},
							...cfgs.map((c) => ({
								value: `refresh ${c.id}`,
								label: `refresh ${c.id}`,
								description: `Force-refresh ${c.id} only`,
							})),
						]
					: undefined,
			),
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);
			switch (sub) {
				case "":
					break;
				case "toggle":
					await handleUsageToggle(rest, ctx);
					return;
				case "refresh":
					await handleUsageRefresh(rest, ctx);
					return;
				case "help":
					await showHelp(
						ctx,
						commandHelp({
							title: "Subscription usage",
							command: "/usage",
							specs: USAGE_SPECS,
							sections: [{ heading: "Settings", lines: [`mode: ${mode}`] }],
						}),
					);
					return;
				default:
					ctx.ui.notify(unknownSubcommand("/usage", sub, USAGE_SPECS), "warning");
					return;
			}

			// Bare `/usage`: the /goal-style menu in the TUI; elsewhere the
			// detailed readout for currently configured providers.
			await refreshActiveUsage(ctx);
			if (menuSupported(ctx)) {
				await showUsageMenu(ctx);
				return;
			}
			ctx.ui.notify(await buildUsageDetails(ctx), "info");
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		route(ctx, true);
	});

	pi.on("model_select", async (_event, ctx) => {
		route(ctx, true);
	});

	// Agent finished answering (incl. auto-retry/compaction settle) — usage
	// may have moved; the cooldown in refresh() decides if a real fetch is due.
	pi.on("agent_settled", async (_event, ctx) => {
		route(ctx, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopDiskCacheWatcher();
		if (cacheSyncTimer) {
			clearTimeout(cacheSyncTimer);
			cacheSyncTimer = undefined;
		}
		for (const c of cfgs) clear(ctx, c.id);
		currentCtx = undefined;
	});
}
