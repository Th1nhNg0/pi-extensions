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
 * hidden (or jumps straight to the given mode); the choice persists in
 * ~/.pi/agent/subscription-usage-prefs.json.
 *
 * `/usage refresh [all|<provider>|active]` force-refetches every usage
 * provider (the default) or just one, bypassing the cooldown guards.
 *
 * Each window also shows a compact countdown (~) until it resets. OpenCode
 * reports `resetsAt` (ISO) per window; Codex reports `reset_at` (epoch s);
 * Antigravity reports `resetTime` (ISO) per bucket. DeepSeek bills on two UTC
 * peak windows (01:00–04:00 and 06:00–10:00), rendered in local time, and
 * the DeepSeek API provider additionally shows the account balance from
 * `GET /user/balance`.
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

/**
 * Thrown when no usable credential (API key or OAuth token) exists for the
 * account. Kept distinct from real fetch failures so `/usage refresh` can
 * report a provider as unavailable instead of failed/retried.
 */
export class MissingCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MissingCredentialError";
	}
}

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

/** Account balance for pay-as-you-go providers (e.g. the DeepSeek API). */
export interface UsageBalance {
	currency: string;
	total: number;
}

/** Percentages per window key, plus optional plan, reset times (ms epoch), and balance. */
export interface UsageData {
	windows: Record<string, number>;
	plan?: string;
	resets?: Record<string, number>;
	balance?: UsageBalance;
	resetsLeft?: number;
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

function normalizeBalance(value: unknown): UsageBalance | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const currency =
		typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
	const total = finiteNumber(record.total);
	if (!currency || total === undefined) return undefined;
	return { currency, total };
}

function normalizeResetsLeft(value: unknown): number | undefined {
	const count = finiteNumber(value);
	return count !== undefined && count >= 0 ? Math.floor(count) : undefined;
}

/** Decode provider or disk-cache data before it reaches rendering or scheduling. */
export function normalizeUsageData(value: unknown): UsageData | undefined {
	const record = asRecord(value);
	const windowsRecord = asRecord(record?.windows);
	const balance = normalizeBalance(record?.balance);
	if (!windowsRecord && !balance) return undefined;

	const windows = windowsRecord
		? (Object.fromEntries(
				Object.entries(windowsRecord).flatMap(([key, percent]) => {
					const normalized = normalizePercent(percent);
					return normalized === undefined ? [] : [[key, normalized] as const];
				}),
			) as Record<string, number>)
		: {};
	if (Object.keys(windows).length === 0 && !balance) return undefined;

	const plan = typeof record?.plan === "string" ? record.plan.trim() : undefined;
	const resets = normalizeResets(record?.resets);
	const resetsLeft = normalizeResetsLeft(record?.resetsLeft);
	return {
		windows,
		...(plan ? { plan } : {}),
		...(resets ? { resets } : {}),
		...(balance ? { balance } : {}),
		...(resetsLeft !== undefined ? { resetsLeft } : {}),
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
	fetchUsage: (signal?: AbortSignal) => Promise<UsageData>;
	render: (
		data: UsageData,
		theme: { fg(color: string, text: string): string },
		modelId?: string,
		style?: UsageStyle,
	) => string;
}

/**
 * Result of one provider refresh: fresh data, reused cache, no credential
 * for the account (nothing was requested), or a real fetch failure.
 */
export type RefreshOutcome = "fetched" | "cached" | "skipped" | "failed";

export interface RefreshResult {
	id: string;
	outcome: RefreshOutcome;
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


/** Plain (theme-free) bar cells for the detailed `/usage` readout. */
export function detailBar(percent: number): string {
	const safePercent = normalizePercent(percent) ?? 0;
	const filled = Math.round((safePercent / 100) * BAR_CELLS);
	return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

/** Preferred window order for the detailed readout; unknown keys sort alphabetically after. */
const DETAIL_WINDOW_ORDER = [
	"5h",
	"rolling",
	"daily",
	"gemini-5h",
	"3p-5h",
	"weekly",
	"gemini-weekly",
	"3p-weekly",
	"monthly",
] as const;

function detailWindowOrder(key: string): number {
	const idx = (DETAIL_WINDOW_ORDER as readonly string[]).indexOf(key);
	return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/** Compact age label for `fetchedAt`, e.g. "just now", "5m ago", "3h ago". */
export function fetchAgeLabel(fetchedAt: number, now = Date.now()): string {
	if (!Number.isFinite(fetchedAt) || !Number.isFinite(now)) return "unknown age";
	const age = now - fetchedAt;
	if (age < 0) return "just now";
	if (age < 60_000) return "just now";
	const m = Math.floor(age / 60_000);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: "$",
	CNY: "¥",
	EUR: "€",
	GBP: "£",
	JPY: "¥",
};

/** Compact balance label, e.g. `$12.34`, or `12.34 SGD` for unknown currencies. */
export function formatBalance(balance: UsageBalance): string {
	const amount = balance.total.toFixed(2);
	const symbol = CURRENCY_SYMBOLS[balance.currency];
	return symbol ? `${symbol}${amount}` : `${amount} ${balance.currency}`;
}

/**
 * Full multi-line breakdown of every usage window for a provider.
 *
 * Used by the `/usage` command (plain text for `ctx.ui.notify`), unlike the
 * single-line footer `render()` which is theme-colored and truncated to the
 * active model's pool. Shows per-window percent + bar + relative reset
 * countdown + absolute reset time, plus plan and freshness when known.
 */
export function formatUsageDetails(
	data: UsageData,
	providerId: string,
	options: { modelId?: string; fetchedAt?: number; now?: number } = {},
): string {
	const now = options.now ?? Date.now();
	const normalized = normalizeUsageData(data);
	if (!normalized) return `${providerId}: no usage data`;
	const headerPlan = normalized.plan ? ` (${normalized.plan})` : "";
	const headerModel = options.modelId ? ` \u2022 ${options.modelId}` : "";
	const lines: string[] = [`Subscription usage \u2014 ${providerId}${headerPlan}${headerModel}`];
	const keys = Object.keys(normalized.windows).sort((a, b) => {
		const order = detailWindowOrder(a) - detailWindowOrder(b);
		return order !== 0 ? order : a.localeCompare(b);
	});
	for (const key of keys) {
		const percent = normalized.windows[key];
		if (typeof percent !== "number") continue;
		const safe = normalizePercent(percent) ?? 0;
		const cells = detailBar(safe);
		const reset = normalized.resets?.[key];
		if (typeof reset === "number" && Number.isFinite(reset)) {
			const rel = resetLabel(reset, now);
			let abs: string;
			try {
				abs = new Date(reset).toISOString().replace("T", " ").slice(0, 16) + " UTC";
			} catch {
				abs = "unknown time";
			}
			lines.push(`\u2022 ${key}: ${safe}% ${cells} \u2014 resets ${rel} (${abs})`);
		} else {
			lines.push(`\u2022 ${key}: ${safe}% ${cells}`);
		}
	}
	if (typeof normalized.resetsLeft === "number") {
		const label =
			normalized.resetsLeft === 1 ? "1 left" : `${normalized.resetsLeft} left`;
		lines.push(`\u2022 resets: ${label}`);
	}
	if (normalized.balance) {
		lines.push(`\u2022 balance: ${formatBalance(normalized.balance)}`);
	}
	if (usesDeepSeekPeakPricing(providerId, options.modelId)) {
		const peak = getDeepSeekPeakInfo(now);
		const tag = peak.isPeak
			? `Peak hours ${resetLabel(peak.nextFlipMs, now)} left`
			: `Off-peak ${resetLabel(peak.nextFlipMs, now)} until peak`;
		lines.push(`\u2022 deepseek pool: ${tag}`);
		lines.push(`\u2022 peak windows: ${formatDeepSeekPeakWindows(now)}`);
	}
	if (typeof options.fetchedAt === "number" && Number.isFinite(options.fetchedAt) && options.fetchedAt > 0) {
		lines.push(`Updated ${fetchAgeLabel(options.fetchedAt, now)}`);
	}
	return lines.join("\n");
}
/** ±JITTER_RATIO randomization so timers don't line up across instances. */
function jitter(ms: number): number {
	return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER_RATIO));
}

/**
 * DeepSeek bills on a UTC clock: two peak windows per day, with a 50%
 * off-peak discount during every other hour. Windows are stored as UTC
 * minutes from midnight so they stay correct across DST changes.
 */
export const DEEPSEEK_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[1 * 60, 4 * 60], // 01:00 - 04:00 UTC
	[6 * 60, 10 * 60], // 06:00 - 10:00 UTC
];

/** Local calendar-day index, used to mark windows that cross local midnight. */
function localDayIndex(ms: number): number {
	return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / 86_400_000);
}

/** `HH:MM` in local time, suffixed with `+1`/`-1` on another local day. */
function localClock(ms: number, referenceDay: number): string {
	const date = new Date(ms);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const offset = localDayIndex(ms) - referenceDay;
	const suffix = offset > 0 ? " +1" : offset < 0 ? " -1" : "";
	return `${hh}:${mm}${suffix}`;
}

/** Format an absolute window as a local `HH:MM–HH:MM` range. */
export function formatLocalTimeRange(startMs: number, endMs: number, now = Date.now()): string {
	const referenceDay = localDayIndex(now);
	return `${localClock(startMs, referenceDay)}–${localClock(endMs, referenceDay)}`;
}

/** `HH:MM` for a UTC minutes-from-midnight value. */
function utcClock(minutes: number): string {
	const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
	const mm = String(minutes % 60).padStart(2, "0");
	return `${hh}:${mm}`;
}

/** Both peak windows as local ranges, plus their canonical UTC ranges. */
export function formatDeepSeekPeakWindows(now = Date.now()): string {
	const d = new Date(now);
	const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const local = DEEPSEEK_PEAK_WINDOWS.map(([start, end]) =>
		formatLocalTimeRange(utcMidnight + start * 60_000, utcMidnight + end * 60_000, now),
	).join(", ");
	const utc = DEEPSEEK_PEAK_WINDOWS.map(
		([start, end]) => `${utcClock(start)}–${utcClock(end)} UTC`,
	).join(", ");
	return `${local} (local) · ${utc}`;
}

/**
 * Peak-hour state for DeepSeek's UTC billing windows. `windowStartMs` and
 * `windowEndMs` describe the active window while peak, or the next window
 * while off-peak, so callers can render a local range without re-deriving it.
 */
export function getDeepSeekPeakInfo(now = Date.now()): {
	isPeak: boolean;
	nextFlipMs: number;
	windowStartMs: number;
	windowEndMs: number;
} {
	const d = new Date(now);
	const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
	const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

	for (const [start, end] of DEEPSEEK_PEAK_WINDOWS) {
		if (utcMins >= start && utcMins < end) {
			const windowStartMs = utcMidnight + start * 60_000;
			const windowEndMs = utcMidnight + end * 60_000;
			return { isPeak: true, nextFlipMs: windowEndMs, windowStartMs, windowEndMs };
		}
	}

	for (const [start, end] of DEEPSEEK_PEAK_WINDOWS) {
		if (utcMins < start) {
			const windowStartMs = utcMidnight + start * 60_000;
			return {
				isPeak: false,
				nextFlipMs: windowStartMs,
				windowStartMs,
				windowEndMs: utcMidnight + end * 60_000,
			};
		}
	}

	// Past the final window: the next peak starts with window 1 tomorrow.
	const [start, end] = DEEPSEEK_PEAK_WINDOWS[0];
	const tomorrow = utcMidnight + 86_400_000;
	const windowStartMs = tomorrow + start * 60_000;
	return {
		isPeak: false,
		nextFlipMs: windowStartMs,
		windowStartMs,
		windowEndMs: tomorrow + end * 60_000,
	};
}

/** True when the active provider/model bills on DeepSeek's peak-hour windows. */
export function usesDeepSeekPeakPricing(providerId?: string, modelId?: string): boolean {
	if (providerId === "deepseek") return true;
	return Boolean(modelId && /deepseek/i.test(modelId));
}

/** Theme-colored peak/off-peak tag with the local window and flip countdown. */
export function deepSeekPeakTag(
	theme: { fg(color: string, text: string): string },
	now = Date.now(),
): string {
	const peak = getDeepSeekPeakInfo(now);
	return peak.isPeak
		? theme.fg("warning", `Peak ${resetLabel(peak.nextFlipMs, now)}`)
		: theme.fg("dim", `Off-Peak ${resetLabel(peak.nextFlipMs, now)}`);
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
	if (usesDeepSeekPeakPricing(providerId, modelId)) {
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

function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!a) return b ?? new AbortController().signal;
	if (!b) return a;
	return AbortSignal.any([a, b]);
}

export const opencodeCfg: ProviderCfg = {
	id: "opencode-go",
	async fetchUsage(signal?: AbortSignal) {
		const rawEnv = process.env.OPENCODE_API_KEY?.trim();
		const cred = rawEnv ? undefined : readStoredCredential("opencode-go");
		const key =
			(rawEnv && rawEnv.length > 0 ? rawEnv : undefined) ??
			(cred && cred.type === "api_key" ? cred.key : undefined);
		if (!key)
			throw new MissingCredentialError("no API key (OPENCODE_API_KEY or auth.json)");

		const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
			headers: { Authorization: `Bearer ${key}` },
			signal: anySignal(signal, AbortSignal.timeout(10_000)),
		});
		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined);
			throw new Error(`HTTP ${res.status}`);
		}
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
		const rawEnv = process.env.DEEPSEEK_API_KEY?.trim();
		const cred = rawEnv ? undefined : readStoredCredential("deepseek");
		const key =
			(rawEnv && rawEnv.length > 0 ? rawEnv : undefined) ??
			(cred && cred.type === "api_key" ? cred.key : undefined);
		if (!key)
			throw new MissingCredentialError("no API key (DEEPSEEK_API_KEY or auth.json)");

		const res = await fetch("https://api.deepseek.com/user/balance", {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			signal: anySignal(signal, AbortSignal.timeout(10_000)),
		});
		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined);
			throw new Error(`HTTP ${res.status}`);
		}
		const json = (await res.json()) as {
			balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>;
		};

		// Prefer USD when the account holds several currencies.
		const balances = (json.balance_infos ?? []).flatMap((entry) => {
			const record = asRecord(entry);
			const currency =
				typeof record?.currency === "string"
					? record.currency.trim().toUpperCase()
					: "";
			const total = Number.parseFloat(String(record?.total_balance ?? ""));
			return currency && Number.isFinite(total) ? [{ currency, total }] : [];
		});
		const balance = balances.find((entry) => entry.currency === "USD") ?? balances[0];
		if (!balance) throw new Error("no balance data");
		return { windows: {}, balance };
	},
	render(data, theme) {
		const parts = [deepSeekPeakTag(theme)];
		if (data.balance) parts.push(formatBalance(data.balance));
		return joinParts(parts, theme);
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
	rate_limit_reset_credits?: {
		available_count?: number;
		applicable_available_count?: number;
	} | null;
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
	const rawResetsLeft = json.rate_limit_reset_credits?.available_count;
	const resetsLeft =
		typeof rawResetsLeft === "number" && Number.isFinite(rawResetsLeft) && rawResetsLeft >= 0
			? Math.floor(rawResetsLeft)
			: undefined;
	const normalized = normalizeUsageData({
		windows,
		plan: json.plan_type,
		resets,
		...(resetsLeft !== undefined ? { resetsLeft } : {}),
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
	async fetchUsage(signal?: AbortSignal) {
		const fromEnv = (
			process.env.OPENAI_CODEX_TOKEN ||
			process.env.CODEX_ACCESS_TOKEN ||
			process.env.CHATGPT_ACCESS_TOKEN
		)?.trim();
		const cred = fromEnv ? undefined : readStoredCredential("openai-codex");
		const access =
			(fromEnv && fromEnv.length > 0 ? fromEnv : undefined) ??
			(cred && cred.type === "oauth" ? cred.access : undefined);
		if (!access) throw new MissingCredentialError("no OAuth token for openai-codex");

		const res = await fetch("https://chatgpt.com/backend-api/codex/usage", {
			headers: {
				Authorization: `Bearer ${access}`,
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
				Accept: "application/json",
			},
			signal: anySignal(signal, AbortSignal.timeout(10_000)),
		});
		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined);
			throw new Error(`HTTP ${res.status}`);
		}
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
		signal: anySignal(signal, AbortSignal.timeout(10_000)),
	});
	if (!res.ok) {
		await res.body?.cancel().catch(() => undefined);
		throw new Error(`token refresh HTTP ${res.status}`);
	}
	const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
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
							signal: anySignal(signal, AbortSignal.timeout(10_000)),
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
					signal: anySignal(signal, AbortSignal.timeout(10_000)),
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

/** Unambiguous short names accepted as `/usage refresh <target>` aliases. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	opencode: "opencode-go",
	"opencode-zen": "opencode-go",
	zen: "opencode-go",
	codex: "openai-codex",
	openai: "openai-codex",
	antigravity: "antigravity",
	google: "antigravity",
	deepseek: "deepseek",
};

/**
 * Resolve a `/usage refresh` target. Empty/`all` means every provider (the
 * default), `active` means the provider behind the current model, and anything
 * else must match a provider id or one of its aliases. Returns `undefined` for
 * an unknown target so the caller can warn without issuing a request.
 */
export function resolveRefreshTargets(
	arg: string,
	cfgs: readonly ProviderCfg[],
	activeProviderId?: string,
): ProviderCfg[] | undefined {
	const target = arg.trim().toLowerCase();
	if (!target || target === "all") return [...cfgs];
	if (target === "active") {
		const active = activeProviderId
			? cfgs.find((c) => c.id.toLowerCase() === activeProviderId.toLowerCase())
			: undefined;
		return active ? [active] : undefined;
	}
	const exact = cfgs.find((c) => c.id.toLowerCase() === target);
	if (exact) return [exact];
	const aliased = PROVIDER_ALIASES[target];
	if (!aliased) return undefined;
	const match = cfgs.find((c) => c.id === aliased);
	return match ? [match] : undefined;
}

/** Human-readable summary of a `/usage refresh` fan-out. */
export function formatRefreshNotice(results: readonly RefreshResult[]): string {
	if (results.length === 0) return "No usage providers to refresh";
	if (results.length === 1) {
		const { id, outcome } = results[0];
		switch (outcome) {
			case "fetched":
				return `Usage refreshed for ${id}`;
			case "cached":
				return `Usage refresh finished from cache for ${id}`;
			case "skipped":
				return `Usage refresh skipped for ${id} (no credentials)`;
			default:
				return `Usage refresh failed for ${id}`;
		}
	}
	const idsWith = (outcome: RefreshOutcome) =>
		results.filter((r) => r.outcome === outcome).map((r) => r.id);
	const fetched = idsWith("fetched");
	const cached = idsWith("cached");
	const skipped = idsWith("skipped");
	const failed = idsWith("failed");
	const parts: string[] = [];
	if (fetched.length === results.length) {
		parts.push(`Usage refreshed for all ${results.length} providers (${fetched.join(", ")})`);
	} else if (fetched.length > 0) {
		parts.push(`Usage refreshed for ${fetched.join(", ")}`);
	} else {
		parts.push("No usage data refreshed");
	}
	if (cached.length > 0) parts.push(`from cache: ${cached.join(", ")}`);
	if (skipped.length > 0) parts.push(`no credentials: ${skipped.join(", ")}`);
	if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
	return parts.join(" · ");
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, ProviderState>();
	let currentCtx: StatusCtx | undefined;
	const cfgs = usageProviderCfgs;
	let mode: UsageMode = loadPrefs().mode;

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
				CACHE_PATH,
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
			fs.unwatchFile(CACHE_PATH, onDiskCacheChange);
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
				if (state.lastFetch >= reset) {
					return jitter(INTERVAL_MS);
				}
				return jitter(Math.min(COOLDOWN_MS, INTERVAL_MS));
			}
			if (dt < INTERVAL_MS + RESET_CATCH_DELAY_MS) {
				return Math.max(dt + RESET_CATCH_DELAY_MS, MIN_FETCH_GAP_MS);
			}
		}
		return jitter(INTERVAL_MS);
	}

	// `hard` (manual /usage refresh) also bypasses the MIN_FETCH_GAP_MS
	// burst guard, so one keystroke always performs a live provider request.
	async function refresh(
		cfg: ProviderCfg,
		ctx: StatusCtx,
		force: boolean,
		hard = false,
		scheduled = false,
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
				await refresh(cfg, ctx, false, false, true);
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
			const outcome = await refresh(cfg, ctx, force);
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
				outcome: await refresh(cfg, ctx, true, true),
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
		description: "Show subscription usage (/usage | toggle | refresh [all|<provider>|active])",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const spaceIndex = trimmed.indexOf(" ");
			if (spaceIndex === -1) {
				const subcommands = [
					{ value: "toggle", label: "toggle", description: "Cycle footer style: bars → percent → off" },
					{ value: "refresh", label: "refresh", description: "Force-refresh every provider now (optionally name one)" },
					{ value: "help", label: "help", description: "Show usage help" },
				];
				const filtered = subcommands.filter((sub) =>
					sub.value.startsWith(trimmed.toLowerCase()),
				);
				return filtered.length > 0 ? filtered : null;
			}
			const sub = trimmed.slice(0, spaceIndex).toLowerCase();
			const rest = trimmed.slice(spaceIndex + 1).trimStart().toLowerCase();
			if (sub === "toggle") {
				const modes = ["bars", "percent", "off"].map((m) => ({
					value: `toggle ${m}`,
					label: `toggle ${m}`,
					description: `Set footer style to ${m}`,
				}));
				const filtered = modes.filter((item) => item.value.startsWith(`toggle ${rest}`));
				return filtered.length > 0 ? filtered : null;
			}
			if (sub === "refresh") {
				const targets = [
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
				];
				const filtered = targets.filter((item) => item.value.startsWith(`refresh ${rest}`));
				return filtered.length > 0 ? filtered : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const sub = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
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
					ctx.ui.notify(
						[
							"Subscription usage commands:",
							"• /usage — detailed usage for all providers",
							"• /usage toggle [bars|percent|off] — cycle or set footer style",
							"• /usage refresh [all|<provider>|active] — force-refresh every provider (default: all)",
						].join("\n"),
						"info",
					);
					return;
				default:
					ctx.ui.notify(
						`Unknown subcommand "${sub}". Usage: /usage | toggle [bars|percent|off] | refresh`,
						"warning",
					);
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
					await refresh(activeCfg, ctx, true, true);
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
