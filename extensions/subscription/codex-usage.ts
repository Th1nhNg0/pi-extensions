/** Codex subscription API response contracts, normalization, and the provider config. */
import {
	MissingCredentialError,
	USAGE_CREDENTIAL_ENV,
	envValue,
	readStoredCredential,
} from "./credentials.ts";
import { fetchJson } from "./http.ts";
import type { PolledProviderCfg } from "./provider-config.ts";
import { joinParts, labeledWindow } from "./rendering.ts";
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

export function codexWindowKey(w: { limit_window_seconds?: number }, fallback = "primary"): string {
	const sec = w.limit_window_seconds;
	if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return fallback;
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

const CODEX_BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const codexCfg: PolledProviderCfg = {
	id: "openai-codex",
	async fetchUsage(signal?: AbortSignal) {
		const fromEnv = envValue(USAGE_CREDENTIAL_ENV["openai-codex"]);
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
