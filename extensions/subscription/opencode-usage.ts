/** OpenCode Go: usage response mapping, window labels, and the provider config. */
import { USAGE_CREDENTIAL_ENV, resolveApiKey } from "./credentials.ts";
import { fetchJson } from "./http.ts";
import type { PolledProviderCfg } from "./provider-config.ts";
import { joinParts, labeledWindow } from "./rendering.ts";
import { deepSeekPeakTag, usesDeepSeekPeakPricing } from "./usage-windows.ts";
import { normalizePercent } from "./usage-cache.ts";
import type { UsageData } from "./usage-cache.ts";

const OPENCODE_WINDOW_LABELS = {
	rolling: "R",
	weekly: "W",
	monthly: "M",
} as const;

export interface OpenCodeUsageResponse {
	usage?: Record<
		string,
		{
			status?: string;
			percent?: number;
			usagePercent?: number;
			resetsAt?: string;
		}
	>;
}

function parseOpenCodeUsage(json: OpenCodeUsageResponse): UsageData {
	const windows: Record<string, number> = {};
	const resets: Record<string, number> = {};
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const window = json.usage?.[key];
		if (!window) continue;
		// Real API reports `percent`; tolerate `usagePercent` on other backend shapes.
		const percent = normalizePercent(window.percent) ?? normalizePercent(window.usagePercent);
		if (percent === undefined) continue;
		windows[key] = percent;
		const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
		if (!Number.isNaN(reset)) resets[key] = reset;
	}
	if (Object.keys(windows).length === 0) throw new Error("no usage data");
	return { windows, resets };
}

/** OpenCode Go: rolling / weekly / monthly usage windows. */
export const opencodeCfg: PolledProviderCfg = {
	id: "opencode-go",
	async fetchUsage(signal?: AbortSignal) {
		const key = resolveApiKey("opencode-go", USAGE_CREDENTIAL_ENV["opencode-go"]);
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
				parts.push(labeledWindow(OPENCODE_WINDOW_LABELS[k], val, data.resets, k, theme, style));
			}
		}
		if (parts.length === 0) return "";

		// DeepSeek pools flip on peak-hour windows; surface the local window
		// plus the countdown to the next flip.
		if (!usesDeepSeekPeakPricing("opencode-go", modelId)) return joinParts(parts, theme);
		return joinParts([deepSeekPeakTag(theme), ...parts], theme);
	},
};
