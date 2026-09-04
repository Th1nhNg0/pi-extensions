/**
 * Subscription usage extension.
 *
 * Shows usage for the active subscription-backed provider as a minimal
 * footer status line, directly below pi's model/thinking indicator (the
 * footer already names the provider, so no prefix is repeated):
 *
 *   ↑1k ↓2k $0.123 12.5%/200k (auto)      kimi-k2 • high
 *   R: ░░░░░░ 4% ~4h · W: ██████ 97% ~8h · M: █████░░░ 62% ~20d
 *   Peak ~2h · R: ░░░░░░ 4% ~4h                    ← DeepSeek peak hours
 *   5h: ░░░░░░ 1% ~4h · W: ░░░░░░ 0% ~6d
 *
 * `/usage-toggle [bars|percent|off]` cycles bars → bare percentages →
 * hidden (or jumps straight to the given mode); the choice persists in
 * ~/.pi/agent/subscription-usage-prefs.json.
 *
 * Each window also shows a compact countdown (~) until it resets. OpenCode
 * reports `resetsAt` (ISO) per window; Codex reports `reset_at` (epoch s);
 * Antigravity reports `resetTime` (ISO) per bucket.
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
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ApiKeyCredential {
	type: "api_key";
	key: string;
}

interface OAuthCredential {
	type: "oauth";
	access: string;
	refresh?: string;
	expires?: number;
}

type StoredCredential = ApiKeyCredential | OAuthCredential;

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");

function readStoredCredential(
	providerId: string,
	authPath = AUTH_PATH,
): StoredCredential | undefined {
	try {
		const raw = fs.readFileSync(authPath, "utf8");
		const data = JSON.parse(raw) as Record<string, StoredCredential>;
		return data?.[providerId];
	} catch {
		return undefined;
	}
}

const INTERVAL_MS = 5 * 60 * 1000; // idle refresh fallback
const COOLDOWN_MS = 60 * 1000; // min gap between real fetches (event pokes)
const MIN_FETCH_GAP_MS = 10_000; // absolute floor between API hits
const ERROR_BACKOFF_BASE_MS = 20_000; // first failed retry waits 20s…
const ERROR_BACKOFF_CAP_MS = 30 * 60 * 1000; // …capped at 30 min
const RESET_CATCH_DELAY_MS = 5_000; // refetch shortly after a window flips
const JITTER_RATIO = 0.2; // ±20%, avoid lockstep with other instances
const BAR_CELLS = 6;
const CACHE_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"subscription-usage-cache.json",
);
const PREFS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"subscription-usage-prefs.json",
);

/** Display style for usage windows: bar cells or bare percentages. */
export type UsageStyle = "bars" | "percent";

export const USAGE_STYLES: readonly UsageStyle[] = ["bars", "percent"];

/** Toggle states: both display styles plus fully hidden ("off"). */
export type UsageMode = UsageStyle | "off";

export const USAGE_MODES: readonly UsageMode[] = ["bars", "percent", "off"];

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

function loadPrefs(): UsagePrefs {
	try {
		return normalizePrefs(
			JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")) as unknown,
		);
	} catch {
		return { mode: "bars" };
	}
}

async function savePrefs(prefs: UsagePrefs): Promise<void> {
	try {
		await fs.promises.mkdir(path.dirname(PREFS_PATH), { recursive: true });
		await fs.promises.writeFile(
			PREFS_PATH,
			`${JSON.stringify(prefs, null, 2)}\n`,
			"utf8",
		);
	} catch (error) {
		console.error("[subscription-usage] failed to save usage prefs:", error);
	}
}

/** Percentages per window key, plus optional plan info and reset times (ms epoch). */
export interface UsageData {
	windows: Record<string, number>;
	plan?: string;
	resets?: Record<string, number>;
}

interface DiskCacheRecord {
	data: UsageData;
	fetchedAt: number;
}

type DiskCache = Record<string, DiskCacheRecord>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePercent(value: unknown): number | undefined {
	const percent = finiteNumber(value);
	return percent === undefined ? undefined : Math.min(100, Math.max(0, percent));
}

function normalizeResets(value: unknown): Record<string, number> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const entries = Object.entries(record).flatMap(([key, reset]) => {
		const value = finiteNumber(reset);
		return value !== undefined && value >= 0 ? [[key, value] as const] : [];
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Decode provider or disk-cache data before it reaches rendering or scheduling. */
export function normalizeUsageData(value: unknown): UsageData | undefined {
	const record = asRecord(value);
	const windowsRecord = asRecord(record?.windows);
	if (!windowsRecord) return undefined;

	const windows = Object.fromEntries(
		Object.entries(windowsRecord).flatMap(([key, percent]) => {
			const normalized = normalizePercent(percent);
			return normalized === undefined ? [] : [[key, normalized] as const];
		}),
	) as Record<string, number>;
	if (Object.keys(windows).length === 0) return undefined;

	const plan = typeof record?.plan === "string" ? record.plan.trim() : undefined;
	const resets = normalizeResets(record?.resets);
	return {
		windows,
		...(plan ? { plan } : {}),
		...(resets ? { resets } : {}),
	};
}

function normalizeDiskCache(value: unknown): DiskCache {
	const record = asRecord(value);
	if (!record) return {};
	const entries = Object.entries(record).flatMap(([providerId, candidate]) => {
		const cacheRecord = asRecord(candidate);
		const data = normalizeUsageData(cacheRecord?.data);
		const fetchedAt = finiteNumber(cacheRecord?.fetchedAt);
		return data && fetchedAt !== undefined && fetchedAt >= 0
			? [[providerId, { data, fetchedAt }] as const]
			: [];
	});
	return Object.fromEntries(entries);
}

let diskCacheSnapshot: DiskCache = {};
let diskCacheWriteQueue: Promise<void> = Promise.resolve();

async function loadDiskCache(): Promise<DiskCache> {
	try {
		const raw = await fs.promises.readFile(CACHE_PATH, "utf8");
		diskCacheSnapshot = normalizeDiskCache(JSON.parse(raw) as unknown);
	} catch {
		// Keep the last valid snapshot during a partial read or file collision.
	}
	return diskCacheSnapshot;
}

async function persistDiskCache(cache: DiskCache): Promise<void> {
	const dir = path.dirname(CACHE_PATH);
	await fs.promises.mkdir(dir, { recursive: true });
	const contents = JSON.stringify(cache, null, 2);
	const tmp = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, contents, "utf8");
		try {
			await fs.promises.rename(tmp, CACHE_PATH);
		} catch {
			// Windows cannot always replace an existing file with rename().
			await fs.promises.writeFile(CACHE_PATH, contents, "utf8");
		}
	} finally {
		await fs.promises.unlink(tmp).catch(() => undefined);
	}
}

async function saveDiskCache(
	providerId: string,
	data: UsageData,
): Promise<void> {
	const previous = diskCacheWriteQueue;
	const operation = (async () => {
		try {
			await previous;
		} catch {
			// A failed write must not block later cache updates.
		}
		const existing = await loadDiskCache();
		existing[providerId] = {
			data: normalizeUsageData(data) ?? data,
			fetchedAt: Date.now(),
		};
		await persistDiskCache(existing);
		diskCacheSnapshot = existing;
	})();
	diskCacheWriteQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	try {
		await operation;
	} catch (error) {
		console.error("[subscription-usage] failed to write disk cache:", error);
	}
}

interface ProviderCfg {
	id: string;
	fetchUsage: () => Promise<UsageData>;
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
	lastFetch: number; // when we last actually hit the API
	lastText: string | undefined;
	lastData: UsageData | undefined; // last successful payload (reset times)
	failStreak: number; // consecutive failures → exponential backoff
	timer: ReturnType<typeof setTimeout> | undefined;
	inFlight: Promise<"fetched" | "cached"> | undefined;
	requestId: number;
}

export function cap(s: string): string {
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Compact remaining-time label for a reset deadline, e.g. "~4h", "~20d",
 * "~<1m" once the window is about to flip. Never shows negative times.
 */
export function resetLabel(resetMs: number, now = Date.now()): string {
	if (!Number.isFinite(resetMs) || !Number.isFinite(now)) return "~?";
	const remain = resetMs - now;
	if (remain <= 60_000) return "~<1m";
	const m = Math.floor(remain / 60_000);
	if (m < 60) return `~${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `~${h}h`;
	const d = Math.floor(h / 24);
	if (d < 30) return `~${d}d`;
	return `~${Math.floor(d / 7)}w`;
}

/** Build a single bar segment: filled/empty cells + percent + reset countdown. */
export function bar(
	percent: number,
	resets: Record<string, number> | undefined,
	key: string,
	theme: { fg(color: string, text: string): string },
	now = Date.now(),
): string {
	const safePercent = normalizePercent(percent) ?? 0;
	const filled = Math.round((safePercent / 100) * BAR_CELLS);
	const cells = "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
	let color = "dim";
	if (safePercent > 90) {
		color = "error";
	} else if (safePercent > 70) {
		color = "warning";
	}
	let out = `${theme.fg(color, cells)}  ${safePercent}%`;
	const r = resets?.[key];
	if (typeof r === "number" && Number.isFinite(r)) {
		out += ` ${theme.fg("dim", resetLabel(r, now))}`;
	}
	return out;
}

/**
 * One window rendered per style: `bar()` output for "bars", a bare
 * colorized percentage for "percent" — both with the reset countdown.
 */
export function windowSegment(
	percent: number,
	resets: Record<string, number> | undefined,
	key: string,
	theme: { fg(color: string, text: string): string },
	style: UsageStyle,
	now = Date.now(),
): string {
	if (style === "percent") {
		const safePercent = normalizePercent(percent) ?? 0;
		let color = "dim";
		if (safePercent > 90) {
			color = "error";
		} else if (safePercent > 70) {
			color = "warning";
		}
		let out = theme.fg(color, `${safePercent}%`);
		const r = resets?.[key];
		if (typeof r === "number" && Number.isFinite(r)) {
			out += ` ${theme.fg("dim", resetLabel(r, now))}`;
		}
		return out;
	}
	return bar(percent, resets, key, theme, now);
}

/** Label + separator + segment, e.g. `R: █░░░░░ 42% ~4h` or `R 42% ~4h`. */
function labeledWindow(
	label: string,
	percent: number,
	resets: Record<string, number> | undefined,
	key: string,
	theme: { fg(color: string, text: string): string },
	style: UsageStyle,
	now = Date.now(),
): string {
	const sep = style === "percent" ? " " : ": ";
	return `${label}${sep}${windowSegment(percent, resets, key, theme, style, now)}`;
}

/** Join window segments with a dim middot (footer collapses runs of spaces). */
function joinParts(
	parts: string[],
	theme: { fg(color: string, text: string): string },
): string {
	return parts.join(` ${theme.fg("dim", "·")} `);
}

/** ±JITTER_RATIO randomization so timers don't line up across instances. */
function jitter(ms: number): number {
	return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER_RATIO));
}

/**
 * Peak hour windows for DeepSeek models on OpenCode Go (UTC):
 * - 01:00 - 04:00 UTC
 * - 06:00 - 10:00 UTC
 */
export function getDeepSeekPeakInfo(now = Date.now()): {
	isPeak: boolean;
	nextFlipMs: number;
} {
	const d = new Date(now);
	const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
	const secOffsetMs = d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();

	// Window 1: 01:00 - 04:00 UTC (60m - 240m)
	// Window 2: 06:00 - 10:00 UTC (360m - 600m)
	if (utcMins >= 60 && utcMins < 240) {
		const remainMs = (240 - utcMins) * 60_000 - secOffsetMs;
		return { isPeak: true, nextFlipMs: now + Math.max(0, remainMs) };
	}
	if (utcMins >= 360 && utcMins < 600) {
		const remainMs = (600 - utcMins) * 60_000 - secOffsetMs;
		return { isPeak: true, nextFlipMs: now + Math.max(0, remainMs) };
	}

	// Off-peak: compute time until next peak window starts
	let minsUntilPeak: number;
	if (utcMins < 60) {
		minsUntilPeak = 60 - utcMins;
	} else if (utcMins < 360) {
		minsUntilPeak = 360 - utcMins;
	} else {
		// Next peak is tomorrow at 01:00 UTC (1440m in a day + 60m = 1500m)
		minsUntilPeak = 1500 - utcMins;
	}
	const remainMs = minsUntilPeak * 60_000 - secOffsetMs;
	return { isPeak: false, nextFlipMs: now + Math.max(0, remainMs) };
}

/** Earliest reset deadline across all tracked windows (ms epoch), if any. */
export function earliestReset(
	data: UsageData | undefined,
	modelId?: string,
	providerId?: string,
	now = Date.now(),
): number | undefined {
	const times = data?.resets
		? Object.values(data.resets).filter((value) => Number.isFinite(value))
		: [];
	if (providerId === "opencode-go" && modelId && /deepseek/i.test(modelId)) {
		times.push(getDeepSeekPeakInfo(now).nextFlipMs);
	}
	return times.length ? Math.min(...times) : undefined;
}

/** OpenCode Go: rolling / weekly / monthly usage windows. */
const OPENCODE_WINDOW_LABELS = {
	rolling: "R",
	weekly: "W",
	monthly: "M",
} as const;

export const opencodeCfg: ProviderCfg = {
	id: "opencode-go",
	async fetchUsage() {
		const fromEnv = process.env.OPENCODE_API_KEY;
		const cred = fromEnv ? undefined : readStoredCredential("opencode-go");
		const key =
			fromEnv ?? (cred && cred.type === "api_key" ? cred.key : undefined);
		if (!key) throw new Error("no API key (OPENCODE_API_KEY or auth.json)");

		const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as {
			usage?: Record<
				string,
				{
					status?: string;
					percent?: number;
					usagePercent?: number;
					resetsAt?: string;
				}
			>;
		};
		const windows: Record<string, number> = {};
		const resets: Record<string, number> = {};
		for (const k of ["rolling", "weekly", "monthly"] as const) {
			const w = json.usage?.[k];
			if (!w) continue;
			// Real API reports `percent`; tolerate `usagePercent` on other
			// backend shapes.
			const p = normalizePercent(w.percent) ?? normalizePercent(w.usagePercent);
			if (p === undefined) continue;
			windows[k] = p;
			const r = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
			if (!Number.isNaN(r)) resets[k] = r;
		}
		if (Object.keys(windows).length === 0) throw new Error("no usage data");
		return { windows, resets };
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

		// DeepSeek pools flip on peak-hour windows; surface that countdown.
		const isDeepSeek = modelId ? /deepseek/i.test(modelId) : false;
		if (!isDeepSeek) return joinParts(parts, theme);
		const peak = getDeepSeekPeakInfo();
		const tag = peak.isPeak
			? theme.fg("warning", `Peak ${resetLabel(peak.nextFlipMs)}`)
			: theme.fg("dim", `Off-Peak ${resetLabel(peak.nextFlipMs)}`);
		return joinParts([tag, ...parts], theme);
	},
};

export interface RateLimitWindowSnapshot {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

export interface CodexUsageResponse {
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: RateLimitWindowSnapshot | null;
		secondary_window?: RateLimitWindowSnapshot | null;
	};
}

export function codexWindowKey(
	w: { limit_window_seconds?: number },
	fallback = "primary",
): string {
	const sec = w.limit_window_seconds;
	if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0)
		return fallback;
	if (sec >= 14_400 && sec <= 21_600) return "5h"; // ~5h (18000s)
	if (sec >= 72_000 && sec <= 100_000) return "daily"; // ~24h (86400s)
	if (sec >= 500_000 && sec <= 700_000) return "weekly"; // ~7d (604800s)
	if (sec >= 2_000_000 && sec <= 3_000_000) return "monthly"; // ~30d (2592000s)
	if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
	return `${Math.round(sec / 60)}m`;
}

export function parseCodexUsage(json: CodexUsageResponse): UsageData {
	const windows: Record<string, number> = {};
	const resets: Record<string, number> = {};
	const addWindow = (
		window: RateLimitWindowSnapshot | null | undefined,
		fallback: string,
	): void => {
		if (!window) return;
		const percent = normalizePercent(window.used_percent);
		if (percent === undefined) return;
		let key = codexWindowKey(window, fallback);
		if (key in windows) key = "secondary";
		windows[key] = percent;
		if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
			resets[key] = Math.max(0, window.reset_at * 1000);
		}
	};

	const hasSecondary = Boolean(json.rate_limit?.secondary_window);
	addWindow(json.rate_limit?.primary_window, hasSecondary ? "5h" : "weekly");
	addWindow(json.rate_limit?.secondary_window, "weekly");

	if (Object.keys(windows).length === 0) throw new Error("no usage data");
	const normalized = normalizeUsageData({
		windows,
		plan: json.plan_type,
		resets,
	});
	if (!normalized) throw new Error("no usage data");
	return normalized;
}

/** OpenAI Codex (ChatGPT subscription): 5h rolling & weekly primary/secondary windows + plan type. */
const CODEX_WINDOW_LABELS: Record<string, string> = {
	"5h": "5h",
	weekly: "W",
	monthly: "M",
	daily: "1d",
};

export const codexCfg: ProviderCfg = {
	id: "openai-codex",
	async fetchUsage() {
		const fromEnv =
			process.env.OPENAI_CODEX_TOKEN ||
			process.env.CODEX_ACCESS_TOKEN ||
			process.env.CHATGPT_ACCESS_TOKEN;
		const cred = fromEnv ? undefined : readStoredCredential("openai-codex");
		const access =
			fromEnv ?? (cred && cred.type === "oauth" ? cred.access : undefined);
		if (!access) throw new Error("no OAuth token for openai-codex");

		const res = await fetch("https://chatgpt.com/backend-api/codex/usage", {
			headers: {
				Authorization: `Bearer ${access}`,
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as CodexUsageResponse;
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

async function refreshAntigravityToken(refreshToken: string): Promise<string> {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: process.env.ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_CLIENT_ID,
			client_secret:
				process.env.ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}).toString(),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`token refresh HTTP ${res.status}`);
	const data = (await res.json()) as { access_token?: unknown };
	if (typeof data.access_token !== "string" || !data.access_token) {
		throw new Error("token refresh response did not include an access token");
	}
	return data.access_token;
}

/** Antigravity (Google Cloud Code Assist): 5h & weekly pools for Gemini and Claude/GPT models. */
export const antigravityCfg: ProviderCfg = {
	id: "antigravity",
	async fetchUsage() {
		const fromEnv =
			process.env.ANTIGRAVITY_TOKEN || process.env.ANTIGRAVITY_API_KEY;
		let access = fromEnv;
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
			throw new Error("no OAuth token or API key for antigravity");

		if (
			refreshToken &&
			(!access || (expires > 0 && Date.now() >= expires - 60_000))
		) {
			try {
				access = await refreshAntigravityToken(refreshToken);
			} catch (e) {
				if (!access) throw e;
			}
		}
		if (!access) throw new Error("antigravity access token is unavailable");

		const baseUrl =
			process.env.ANTIGRAVITY_BASE_URL?.trim() ||
			"https://cloudcode-pa.googleapis.com";
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

		function queryQuota(token: string) {
			return fetch(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, {
				method: "POST",
				headers: { ...headers, Authorization: `Bearer ${token}` },
				body: JSON.stringify({}),
				signal: AbortSignal.timeout(10_000),
			});
		}

		let resQuota = await queryQuota(access);
		if (resQuota.status === 401 && refreshToken) {
			access = await refreshAntigravityToken(refreshToken);
			resQuota = await queryQuota(access);
		}

		if (!resQuota.ok) throw new Error(`HTTP ${resQuota.status}`);
		const quotaJson = (await resQuota.json()) as {
			groups?: Array<{
				displayName?: string;
				buckets?: Array<{
					bucketId?: string;
					displayName?: string;
					window?: string;
					resetTime?: string;
					remainingFraction?: number;
				}>;
			}>;
		};

		const windows: Record<string, number> = {};
		const resets: Record<string, number> = {};
		for (const group of quotaJson.groups || []) {
			for (const b of group.buckets || []) {
				const k = b.bucketId || b.window;
				if (!k) continue;
				if (
					typeof b.remainingFraction === "number" &&
					Number.isFinite(b.remainingFraction)
				) {
					const remaining = Math.min(1, Math.max(0, b.remainingFraction));
					windows[k] = Math.round((1 - remaining) * 100);
				}
				if (b.resetTime) {
					const r = Date.parse(b.resetTime);
					if (!Number.isNaN(r)) resets[k] = r;
				}
			}
		}

		if (Object.keys(windows).length === 0) throw new Error("no usage data");

		let plan: string | undefined;
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
				signal: AbortSignal.timeout(10_000),
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
			}
		} catch {
			// ignore tier lookup failure
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

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, ProviderState>();
	let currentCtx: StatusCtx | undefined;
	const cfgs = [opencodeCfg, codexCfg, antigravityCfg];
	let mode: UsageMode = loadPrefs().mode;

	function renderUi(
		ui: StatusCtx["ui"] | undefined,
		providerId: string,
		text: string | undefined,
	): void {
		if (!ui) return;
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
			lastText: undefined,
			lastData: undefined,
			failStreak: 0,
			timer: undefined,
			inFlight: undefined,
			requestId: 0,
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

		const disk = (await loadDiskCache())[cfg.id];
		if (!disk?.data || !Number.isFinite(disk.fetchedAt)) return;
		const state = cache.get(cfg.id) ?? freshState();
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

	function startDiskCacheWatcher(): void {
		if (cacheWatcherActive) return;
		try {
			fs.watchFile(CACHE_PATH, { interval: 1000 }, (curr, prev) => {
				if (curr.mtimeMs !== prev.mtimeMs) scheduleDiskSync();
			});
			cacheWatcherActive = true;
		} catch {
			// Ignore watch error if the cache path is not accessible yet.
		}
	}

	function stopDiskCacheWatcher(): void {
		if (!cacheWatcherActive) return;
		try {
			fs.unwatchFile(CACHE_PATH);
		} catch {
			// Ignore unwatch failure during shutdown.
		}
		cacheWatcherActive = false;
		if (cacheSyncTimer) clearTimeout(cacheSyncTimer);
		cacheSyncTimer = undefined;
	}

	startDiskCacheWatcher();

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

	/**
	 * Next delay until the next fetch: exponential backoff while the API is
	 * failing; otherwise wake right after the nearest reset flips, or fall
	 * back to the idle interval.
	 */
	function nextDelay(
		state: ProviderState,
		now: number,
		modelId?: string,
		providerId?: string,
	): number {
		if (state.failStreak > 0) {
			const backoff = Math.min(
				ERROR_BACKOFF_BASE_MS * 2 ** (state.failStreak - 1),
				ERROR_BACKOFF_CAP_MS,
			);
			return jitter(backoff);
		}
		const reset = earliestReset(state.lastData, modelId, providerId, now);
		if (reset !== undefined) {
			const dt = reset - now;
			if (dt <= 0) {
				// A window flipped while we weren't looking — catch up soon.
				// The cooldown inside refresh() still gates the actual HTTP call.
				return jitter(Math.min(COOLDOWN_MS, INTERVAL_MS));
			}
			if (dt < INTERVAL_MS + RESET_CATCH_DELAY_MS) {
				// Reset is imminent: wake right after it so the fresh pool
				// shows up instead of sleeping through the flip.
				return Math.max(dt + RESET_CATCH_DELAY_MS, MIN_FETCH_GAP_MS);
			}
		}
		return jitter(INTERVAL_MS);
	}

	// `hard` (manual /usage-refresh) also bypasses the MIN_FETCH_GAP_MS
	// burst guard, so one keystroke always performs a live provider request.
	async function refresh(
		cfg: ProviderCfg,
		ctx: StatusCtx,
		force: boolean,
		hard = false,
	): Promise<"fetched" | "cached"> {
		const state = cache.get(cfg.id) ?? freshState();
		cache.set(cfg.id, state);
		if (state.inFlight && !force) return state.inFlight;
		const requestId = state.requestId + 1;
		state.requestId = requestId;
		const isCurrentRequest = (): boolean =>
			cache.get(cfg.id) === state && state.requestId === requestId;

		const request = (async (): Promise<"fetched" | "cached"> => {
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
				state.lastText !== undefined &&
				(now - state.lastFetch < COOLDOWN_MS ||
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
			// duplicate burst request. Manual /usage-refresh (hard) skips this.
			if (!hard && now - state.lastFetch < MIN_FETCH_GAP_MS && state.lastData) {
				const ui = safeUi(ctx);
				if (ui) {
					state.lastText = renderText(cfg, state.lastData, ui, model?.id);
					renderUi(ui, cfg.id, state.lastText);
				}
				return "cached";
			}

			state.lastFetch = now;
			try {
				const data = normalizeUsageData(await cfg.fetchUsage());
				if (!data) throw new Error("provider returned no valid usage data");
				// The session or model may have changed while awaiting the fetch.
				const ui = safeUi(ctx);
				if (!ui || !isCurrentRequest()) return "cached";
				state.failStreak = 0;
				state.lastData = data;
				state.lastText = renderText(cfg, data, ui, model?.id);
				renderUi(ui, cfg.id, state.lastText);
				await saveDiskCache(cfg.id, data);
				return "fetched";
			} catch (err) {
				// Stale ctx after session replacement: drop quietly, don't crash.
				const ui = safeUi(ctx);
				if (!ui || !isCurrentRequest()) return "cached";
				state.failStreak += 1;
				console.error(
					`[${cfg.id}-usage] fetch failed (${state.failStreak}×): ` +
						(err instanceof Error ? err.message : String(err)),
				);
				if (state.lastText !== undefined && !state.lastText.includes("err")) {
					// Keep the last known numbers, tinted so staleness is visible.
					state.lastText = ui.theme.fg("warning", `${state.lastText} ⚠`);
					renderUi(ui, cfg.id, state.lastText);
				} else {
					state.lastText = ui.theme.fg("error", `${cfg.id}: err`);
					renderUi(ui, cfg.id, state.lastText);
				}
				return "cached";
			}
		})();
		state.inFlight = request;
		try {
			return await request;
		} finally {
			if (state.inFlight === request) state.inFlight = undefined;
		}
	}

	/** (Re)arm the next scheduled fetch with a delay computed from the last outcome. */
	function arm(cfg: ProviderCfg, ctx: StatusCtx, delayMs: number) {
		const state = cache.get(cfg.id) ?? freshState();
		if (state.timer) clearTimeout(state.timer);
		cache.set(cfg.id, state);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			void (async () => {
				// Bail if the session is gone or this exact provider state was
				// cleared (e.g. the model switched away and back).
				if (!safeUi(ctx) || cache.get(cfg.id) !== state) return;
				await refresh(cfg, ctx, false);
				if (!safeUi(ctx) || cache.get(cfg.id) !== state) return;
				const model = safeModel(ctx);
				arm(cfg, ctx, nextDelay(state, Date.now(), model?.id, cfg.id));
			})();
		}, delayMs);
		// Don't keep the process alive on the timer alone (unref is a no-op
		// inside pi's TUI, where the render loop already holds the event loop).
		state.timer.unref?.();
	}

	/** Immediate refresh + rearm from the fresh outcome (used by events). */
	function poke(cfg: ProviderCfg, ctx: StatusCtx, force: boolean) {
		const state = cache.get(cfg.id);
		if (state?.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		void (async () => {
			if (!safeUi(ctx)) return;
			await refresh(cfg, ctx, force);
			// Rearm from the result, unless the session was replaced or this
			// provider got cleared while we were awaiting.
			const s = cache.get(cfg.id);
			const model = safeModel(ctx);
			if (s && safeUi(ctx))
				arm(cfg, ctx, nextDelay(s, Date.now(), model?.id, cfg.id));
		})();
	}

	function clear(ctx: StatusCtx, key: string) {
		const state = cache.get(key);
		if (state?.timer) clearTimeout(state.timer);
		cache.delete(key);
		renderUi(safeUi(ctx), key, undefined);
	}

	/** Route to the right provider config for the active model. */
	function route(ctx: StatusCtx, force: boolean) {
		currentCtx = ctx;
		// Hidden mode: no statuses, no timers, no fetches at all.
		if (mode === "off") return;
		const provider = safeModel(ctx)?.provider;
		const active = cfgs.find((c) => c.id === provider);
		// Clear statuses+timers for all non-matching providers first, then
		// poke the active one (which re-arms with its own adaptive timer).
		for (const c of cfgs) {
			if (c !== active) clear(ctx, c.id);
		}
		if (active) poke(active, ctx, force);
	}

	/**
	 * `/usage-toggle [bars|percent|off]` — cycle bars → percent → off, or
	 * jump straight to the given mode. The choice persists across sessions.
	 */
	pi.registerCommand("usage-toggle", {
		description:
			"Cycle subscription usage display: bars → percent → off (or set directly)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{
					value: "bars",
					label: "bars",
					description: "Visual quota progress bars",
				},
				{
					value: "percent",
					label: "percent",
					description: "Compact percentage numbers",
				},
				{
					value: "off",
					label: "off",
					description: "Hide usage readout completely",
				},
			];
			const filtered = items.filter((item) =>
				item.value.startsWith(prefix.trimStart().toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			let next: UsageMode;
			const arg = args.trim().toLowerCase();
			if (arg) {
				const parsed = normalizeUsageMode(arg);
				if (!parsed) {
					ctx.ui.notify(
						`Unknown mode "${args.trim()}". Options: ${USAGE_MODES.join(", ")}`,
						"warning",
					);
					return;
				}
				next = parsed;
			} else {
				// Cycle: bars → percent → off → bars
				next = USAGE_MODES[(USAGE_MODES.indexOf(mode) + 1) % USAGE_MODES.length];
			}

			mode = next;
			await savePrefs({ mode });

			if (next === "off") {
				// Hide: drop statuses and stop every timer/fetch for this session.
				for (const c of cfgs) clear(ctx, c.id);
				ctx.ui.notify(
					"Subscription usage hidden (/usage-toggle restores it)",
					"info",
				);
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
		},
	});

	/**
	 * `/usage-refresh` — force a live refetch for the active provider right
	 * now, bypassing the cooldown and burst guards. Useful when the source
	 * API lags (e.g. Antigravity quota summary right after a reset) and you
	 * want to rule out client-side staleness in one keystroke.
	 */
	pi.registerCommand("usage-refresh", {
		description:
			"Force-refresh subscription usage now, bypassing the fetch cooldown",
		handler: async (_args, ctx) => {
			const model = safeModel(ctx);
			const cfg = cfgs.find((c) => c.id === model?.provider);
			if (!cfg) {
				ctx.ui.notify(
					`No usage provider for "${model?.provider ?? "unknown"}"`,
					"warning",
				);
				return;
			}
			const outcome = await refresh(cfg, ctx, true, true);
			const s = cache.get(cfg.id);
			const current = safeModel(ctx);
			if (s && safeUi(ctx))
				arm(cfg, ctx, nextDelay(s, Date.now(), current?.id, cfg.id));
			if (mode === "off") {
				ctx.ui.notify(`Usage refreshed for ${cfg.id} (display is off)`, "info");
				return;
			}
			ctx.ui.notify(
				outcome === "fetched"
					? `Usage refreshed for ${cfg.id}`
					: `Usage refresh finished from cache for ${cfg.id}`,
				"info",
			);
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
