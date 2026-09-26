/** Codex subscription API response contracts and normalization. */
import { normalizePercent, normalizeUsageData } from "./usage-cache.ts";
import type { UsageData } from "./usage-cache.ts";

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
