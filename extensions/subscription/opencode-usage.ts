/** OpenCode Go usage response mapping and provider window labels. */
import { normalizePercent } from "./usage-cache.ts";
import type { UsageData } from "./usage-cache.ts";

export const OPENCODE_WINDOW_LABELS = {
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

export function parseOpenCodeUsage(json: OpenCodeUsageResponse): UsageData {
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
