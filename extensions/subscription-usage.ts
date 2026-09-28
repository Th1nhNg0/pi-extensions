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
 * `/usage` shows the detailed readout for all providers;
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
import { codexWindowKey, parseCodexUsage } from "./subscription/codex-usage.ts";
import type { CodexUsageResponse, RateLimitWindowSnapshot } from "./subscription/codex-usage.ts";
export { codexWindowKey, parseCodexUsage };
export type { CodexUsageResponse, RateLimitWindowSnapshot };
import { COOLDOWN_MS, MIN_FETCH_GAP_MS, nextDelay } from "./subscription/refresh-schedule.ts";
import { parseAntigravityQuota } from "./subscription/antigravity-quota.ts";
import type { AntigravityQuotaSummary } from "./subscription/antigravity-quota.ts";
import {
  OPENCODE_WINDOW_LABELS,
  parseOpenCodeUsage,
} from "./subscription/opencode-usage.ts";
import type { OpenCodeUsageResponse } from "./subscription/opencode-usage.ts";
import { formatBalance, parseDeepSeekBalance } from "./subscription/balance.ts";
import type { DeepSeekBalanceResponse } from "./subscription/balance.ts";
export { formatBalance };
import {
	MissingCredentialError,
	envValue,
	readStoredCredential,
	resolveApiKey,
} from "./subscription/credentials.ts";
export { MissingCredentialError };
import {
  bar,
  detailBar,
  fetchAgeLabel,
  formatUsageDetails,
  joinParts,
  labeledWindow,
  windowSegment,
} from "./subscription/rendering.ts";
import type { UsageStyle } from "./subscription/rendering.ts";
export { bar, detailBar, fetchAgeLabel, formatUsageDetails, windowSegment };
export type { UsageStyle };
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
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
import { formatRefreshNotice, resolveRefreshTargets as resolveRefreshTargetsImpl } from "./subscription/refresh-command.ts";
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
	{ name: "", description: "detailed usage for every provider" },
	{ name: "toggle", values: USAGE_MODES, description: "cycle the footer style: bars → percent → off" },
	{ name: "refresh", hint: "[all|<provider>|active]", description: "force-refresh providers (default: every one)" },
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




interface ProviderCfg {
	id: string;
	fetchUsage: (signal?: AbortSignal) => Promise<UsageData>;
	render: (
		data: UsageData,
		theme: { fg(color: string, text: string): string },
		modelId?: string,
		style?: UsageStyle,
	) => string;
}


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


/** OpenCode Go: rolling / weekly / monthly usage windows. */

function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!a) return b ?? new AbortController().signal;
	if (!b) return a;
	return AbortSignal.any([a, b]);
}

const FETCH_TIMEOUT_MS = 10_000;

/** Signal for one provider request: the caller's abort plus a hard timeout. */
function requestSignal(signal?: AbortSignal): AbortSignal {
	return anySignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS));
}

/**
 * One provider request: timeout-bounded, the body drained on a non-2xx status
 * so the socket is released, and an `${errorPrefix}HTTP <status>` error.
 */
async function fetchJson<T>(
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
	errorPrefix = "",
): Promise<T> {
	const res = await fetch(url, { ...init, signal: requestSignal(signal) });
	if (!res.ok) {
		await res.body?.cancel().catch(() => undefined);
		throw new Error(`${errorPrefix}HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

export const opencodeCfg: ProviderCfg = {
	id: "opencode-go",
	async fetchUsage(signal?: AbortSignal) {
		const key = resolveApiKey("opencode-go", ["OPENCODE_API_KEY"]);
		const json = await fetchJson<OpenCodeUsageResponse>(
			"https://opencode.ai/zen/go/v1/usage",
			{ headers: { Authorization: `Bearer ${key}` } },
			signal,
		);
		return parseOpenCodeUsage(json);
	},
	render(data, theme, modelId, style = "bars") {
		const w = data.windows;
		const parts: string[] = [];
		for (const k of ["rolling", "weekly", "monthly"] as const) {
			const val = w[k];
			if (typeof val === "number") {
				parts.push(
					labeledWindow(
						OPENCODE_WINDOW_LABELS[k],
						val,
						data.resets,
						k,
						theme,
						style,
					),
				);
			}
		}
		if (parts.length === 0) return "";

		// DeepSeek pools flip on peak-hour windows; surface the local window
		// plus the countdown to the next flip.
		if (!usesDeepSeekPeakPricing("opencode-go", modelId)) return joinParts(parts, theme);
		return joinParts([deepSeekPeakTag(theme), ...parts], theme);
	},
};

/** DeepSeek API (pay-as-you-go): account balance plus peak/off-peak billing state. */
export const deepseekCfg: ProviderCfg = {
	id: "deepseek",
	async fetchUsage(signal?: AbortSignal) {
		const key = resolveApiKey("deepseek", ["DEEPSEEK_API_KEY"]);
		const json = await fetchJson<DeepSeekBalanceResponse>(
			"https://api.deepseek.com/user/balance",
			{ headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
			signal,
		);
		const balance = parseDeepSeekBalance(json);
		return { windows: {}, balance };
	},
	render(data, theme) {
		const parts = [deepSeekPeakTag(theme)];
		if (data.balance) parts.push(formatBalance(data.balance));
		return joinParts(parts, theme);
	},
};

/** OpenAI Codex (ChatGPT subscription): 5h rolling & weekly primary/secondary windows + plan type. */
const CODEX_WINDOW_LABELS: Record<string, string> = {
	"5h": "5h",
	weekly: "W",
	monthly: "M",
	daily: "1d",
};

const CODEX_BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const codexCfg: ProviderCfg = {
	id: "openai-codex",
	async fetchUsage(signal?: AbortSignal) {
		const fromEnv = envValue(["OPENAI_CODEX_TOKEN", "CODEX_ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN"]);
		const cred = fromEnv ? undefined : readStoredCredential("openai-codex");
		const access = fromEnv ?? (cred?.type === "oauth" ? cred.access : undefined);
		if (!access) throw new MissingCredentialError("no OAuth token for openai-codex");

		const json = await fetchJson<CodexUsageResponse>(
			"https://chatgpt.com/backend-api/codex/usage",
			{
				headers: {
					Authorization: `Bearer ${access}`,
					// Cloudflare rejects non-browser agents; override when this one goes stale.
					"User-Agent": envValue(["CODEX_USER_AGENT"]) ?? CODEX_BROWSER_USER_AGENT,
					Accept: "application/json",
				},
			},
			signal,
		);
		return parseCodexUsage(json);
	},
	render(data, theme, _modelId, style = "bars") {
		const w = data.windows;
		const parts: string[] = [];

		const orderedKeys = ["5h", "daily", "weekly", "monthly"];
		const seen = new Set<string>();

		for (const k of orderedKeys) {
			if (typeof w[k] === "number") {
				seen.add(k);
				const label = CODEX_WINDOW_LABELS[k] ?? k;
				parts.push(labeledWindow(label, w[k], data.resets, k, theme, style));
			}
		}

		for (const [k, v] of Object.entries(w)) {
			if (!seen.has(k) && typeof v === "number") {
				parts.push(labeledWindow(k, v, data.resets, k, theme, style));
			}
		}

		if (typeof data.resetsLeft === "number" && data.resetsLeft > 0) {
			const label = `${data.resetsLeft} reset${data.resetsLeft === 1 ? "" : "s"} left`;
			parts.push(theme.fg("dim", label));
		}

		if (parts.length === 0) return "";
		return joinParts(parts, theme);
	},
};

const ANTIGRAVITY_CLIENT_ID = Buffer.from(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
		"C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
	"base64",
).toString("utf8");
const ANTIGRAVITY_CLIENT_SECRET = Buffer.from(
	"R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
	"base64",
).toString("utf8");

const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;
const RETRYABLE_ANTIGRAVITY_STATUSES = new Set([
	403,
	404,
	429,
	500,
	502,
	503,
	504,
]);

/** Match pi-antigravity's endpoint order so quota reads use the same pool. */
export function antigravityEndpointCandidates(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const explicit = env.ANTIGRAVITY_BASE_URL?.trim();
	return explicit ? [explicit] : [...ANTIGRAVITY_ENDPOINTS];
}

interface CachedAntigravityToken {
	token: string;
	expiresAt: number;
}
let cachedAntigravityToken: CachedAntigravityToken | undefined;
let cachedAntigravityTier: { plan: string | undefined; cachedAt: number } | undefined;
const TIER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function refreshAntigravityToken(
	refreshToken: string,
	signal?: AbortSignal,
): Promise<string> {
	if (cachedAntigravityToken && Date.now() < cachedAntigravityToken.expiresAt) {
		return cachedAntigravityToken.token;
	}
	const data = await fetchJson<{ access_token?: unknown; expires_in?: unknown }>(
		"https://oauth2.googleapis.com/token",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: process.env.ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_CLIENT_ID,
				client_secret:
					process.env.ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_CLIENT_SECRET,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}).toString(),
		},
		signal,
		"token refresh ",
	);
	if (typeof data.access_token !== "string" || !data.access_token) {
		throw new Error("token refresh response did not include an access token");
	}
	const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
	cachedAntigravityToken = {
		token: data.access_token,
		expiresAt: Date.now() + Math.max(60_000, (expiresInSec - 60) * 1000),
	};
	return data.access_token;
}

/** Antigravity (Google Cloud Code Assist): 5h & weekly pools for Gemini and Claude/GPT models. */
export const antigravityCfg: ProviderCfg = {
	id: "antigravity",
	async fetchUsage(signal?: AbortSignal) {
		const fromEnv =
			process.env.ANTIGRAVITY_TOKEN || process.env.ANTIGRAVITY_API_KEY;
		let access = fromEnv?.trim();
		let refreshToken: string | undefined;
		let expires = 0;

		if (!access) {
			const cred = readStoredCredential("antigravity");
			if (cred && cred.type === "oauth") {
				access = cred.access;
				refreshToken = cred.refresh;
				expires = typeof cred.expires === "number" ? cred.expires : 0;
			}
		}

		if (!access && !refreshToken)
			throw new MissingCredentialError("no OAuth token or API key for antigravity");

		if (
			refreshToken &&
			(!access || (expires > 0 && Date.now() >= expires - 60_000))
		) {
			try {
				access = await refreshAntigravityToken(refreshToken, signal);
			} catch (e) {
				if (!access) throw e;
			}
		}
		if (!access) throw new MissingCredentialError("antigravity access token is unavailable");

		const endpoints = antigravityEndpointCandidates();
		const headers: Record<string, string> = {
			Authorization: `Bearer ${access}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent":
				process.env.ANTIGRAVITY_USER_AGENT || "antigravity/1.15.8 windows/amd64",
			"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
			"Client-Metadata": JSON.stringify({
				ideType: "ANTIGRAVITY",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			}),
		};

		async function queryQuota(
			token: string,
		): Promise<{ response: Response; endpoint: string }> {
			let lastResponse: Response | undefined;
			let lastEndpoint: string | undefined;
			let lastError: unknown;
			for (const endpoint of endpoints) {
				try {
					const response = await fetch(
						`${endpoint}/v1internal:retrieveUserQuotaSummary`,
						{
							method: "POST",
							headers: { ...headers, Authorization: `Bearer ${token}` },
							body: JSON.stringify({}),
							signal: requestSignal(signal),
						},
					);
					lastResponse = response;
					lastEndpoint = endpoint;
					if (response.ok || !RETRYABLE_ANTIGRAVITY_STATUSES.has(response.status)) {
						return { response, endpoint };
					}
					await response.body?.cancel().catch(() => undefined);
				} catch (error) {
					lastError = error;
				}
			}
			if (lastResponse && lastEndpoint) {
				return { response: lastResponse, endpoint: lastEndpoint };
			}
			throw lastError instanceof Error
				? lastError
				: new Error("all Antigravity quota endpoints failed");
		}

		let quotaResult = await queryQuota(access);
		if (quotaResult.response.status === 401 && refreshToken) {
			cachedAntigravityToken = undefined;
			access = await refreshAntigravityToken(refreshToken, signal);
			quotaResult = await queryQuota(access);
		}
		const resQuota = quotaResult.response;
		const baseUrl = quotaResult.endpoint;

		if (!resQuota.ok) {
			await resQuota.body?.cancel().catch(() => undefined);
			throw new Error(`HTTP ${resQuota.status}`);
		}
		const quotaJson = (await resQuota.json()) as AntigravityQuotaSummary;
		const { windows, resets } = parseAntigravityQuota(quotaJson);
		let plan =
			cachedAntigravityTier && Date.now() - cachedAntigravityTier.cachedAt < TIER_CACHE_TTL_MS
				? cachedAntigravityTier.plan
				: undefined;
		if (plan === undefined) {
			try {
				const resAssist = await fetch(`${baseUrl}/v1internal:loadCodeAssist`, {
					method: "POST",
					headers: { ...headers, Authorization: `Bearer ${access}` },
					body: JSON.stringify({
						metadata: {
							ideType: "ANTIGRAVITY",
							platform: "PLATFORM_UNSPECIFIED",
							pluginType: "GEMINI",
						},
					}),
					signal: requestSignal(signal),
				});
				if (resAssist.ok) {
					const assistJson = (await resAssist.json()) as {
						paidTier?: { id?: string; name?: string };
						currentTier?: { id?: string; name?: string };
					};
					const paid = assistJson.paidTier?.name;
					const current = assistJson.currentTier?.name;
					if (paid) {
						plan = paid.replace(/^Google AI\s*/i, "");
					} else if (current) {
						plan = current === "Antigravity" ? "Free" : current;
					}
					cachedAntigravityTier = { plan, cachedAt: Date.now() };
				} else {
					await resAssist.body?.cancel().catch(() => undefined);
				}
			} catch {
				// ignore tier lookup failure
			}
		}

		return { windows, plan, resets };
	},
	render(data, theme, modelId, style = "bars") {
		const w = data.windows;
		const isClaude = modelId ? /claude/i.test(modelId) : false;
		const isGpt = modelId ? /gpt/i.test(modelId) : false;
		const is3p = isClaude || isGpt || (modelId ? /3p/i.test(modelId) : false);

		let bucketKeys: Array<[string, string]>;

		if (is3p) {
			bucketKeys = [
				["3p-5h", "5h"],
				["3p-weekly", "W"],
			];
		} else {
			bucketKeys = [
				["gemini-5h", "5h"],
				["gemini-weekly", "W"],
			];
		}

		const hasSelectedData = bucketKeys.some(([k]) => typeof w[k] === "number");
		if (!hasSelectedData) {
			// Model's pool is unknown — show every bucket with disambiguating labels.
			bucketKeys = [
				["gemini-5h", "G-5h"],
				["gemini-weekly", "G-W"],
				["3p-5h", "3P-5h"],
				["3p-weekly", "3P-W"],
			];
		}

		const parts: string[] = [];
		for (const [k, label] of bucketKeys) {
			const val = w[k];
			if (typeof val === "number") {
				parts.push(labeledWindow(label, val, data.resets, k, theme, style));
			}
		}

		if (parts.length === 0) return "";
		return joinParts(parts, theme);
	},
};

/**
 * Every usage provider this extension can query, in display order. `/usage
 * refresh` fans out over this list unless a narrower target is given.
 */
export const usageProviderCfgs: readonly ProviderCfg[] = [
	opencodeCfg,
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
		cfg: ProviderCfg,
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
		if (!cfg) return;

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
			fs.watchFile(
				getCacheFile(),
				{ interval: 1000, persistent: false },
				onDiskCacheChange,
			);
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
				(now - state.lastAttempt < COOLDOWN_MS ||
					(state.failStreak > 0 && !resetSoon))
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
	function arm(cfg: ProviderCfg, ctx: StatusCtx, delayMs: number) {
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
	function poke(cfg: ProviderCfg, ctx: StatusCtx, force: boolean) {
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
		if (active) {
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
	type UsageCmdCtx = Parameters<
		Parameters<typeof pi.registerCommand>[1]["handler"]
	>[1];

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
		const ui = safeUi(ctx);
		const state = cfg ? cache.get(cfg.id) : undefined;
		if (cfg && ui && state?.lastData) {
			state.lastText = renderText(cfg, state.lastData, ui, model?.id);
			renderUi(ui, cfg.id, state.lastText);
			// Leaving "off" killed this provider's timer — re-arm it.
			if (!state.timer)
				arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
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
			ctx.ui.notify(
				"Subscription usage is hidden; use /usage toggle to enable refreshes",
				"info",
			);
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
			targets.map(async (cfg): Promise<RefreshResult> => ({
				id: cfg.id,
				outcome: await refresh(cfg, ctx, { force: true, hard: true }),
			})),
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
		if (activeCfg && state && safeUi(ctx))
			arm(activeCfg, ctx, nextDelay(state, Date.now(), current?.id, activeCfg.id));
		ctx.ui.notify(formatRefreshNotice(results), "info");
	}

	/**
	 * Single `/usage` command: bare `/usage` shows the detailed readout;
	 * `/usage toggle [bars|percent|off]` cycles the footer style;
	 * `/usage refresh [all|<provider>|active]` force-refetches every usage
	 * provider (default) or the named/active one.
	 */
	pi.registerCommand("usage", {
		description: `Show subscription usage (${usageLine("/usage", USAGE_SPECS).replace("Usage: ", "")})`,
		getArgumentCompletions: (prefix) =>
			argumentCompletions(USAGE_SPECS, prefix, (sub) =>
				sub === "refresh"
					? [
							{ value: "refresh all", label: "refresh all", description: "Force-refresh every usage provider" },
							{ value: "refresh active", label: "refresh active", description: "Force-refresh the active provider only" },
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

			// Bare `/usage`: detailed readout for all providers.
			const model = safeModel(ctx);
			const activeCfg = cfgs.find((c) => c.id === model?.provider);
			// One live fetch for the active provider; the rest render from cache
			// so one keystroke never fans out to every API.
			// While hidden (`off`) there are no fetches at all; render from cache.
			if (activeCfg && mode !== "off") {
				try {
					await refresh(activeCfg, ctx, { force: true, hard: true });
				} catch {
					// refresh() already renders footer errors; details fall back to cache below.
				}
				const s = cache.get(activeCfg.id);
				const current = safeModel(ctx);
				if (s && safeUi(ctx))
					arm(activeCfg, ctx, nextDelay(s, Date.now(), current?.id, activeCfg.id));
			}
			const sections: string[] = [];
			for (const cfg of cfgs) {
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
			ctx.ui.notify(sections.join("\n\n") + hiddenHint, "info");
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		startDiskCacheWatcher();
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
