/** Shared rendering for provider footer windows and detailed usage output. */
import { formatBalance } from "./balance.ts";
import { normalizePercent, normalizeUsageData } from "./usage-cache.ts";
import type { UsageData } from "./usage-cache.ts";
import {
	deepSeekOffPeakDetail,
	formatDeepSeekPeakWindows,
	getDeepSeekPeakInfo,
	resetLabel,
	utcStamp,
	usesDeepSeekPeakPricing,
} from "./usage-windows.ts";

export type UsageStyle = "bars" | "percent";

const BAR_CELLS = 6;

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
export function labeledWindow(
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
export function joinParts(
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
			const abs = utcStamp(reset);
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
			: deepSeekOffPeakDetail(peak, now);
		lines.push(`\u2022 deepseek pool: ${tag}`);
		lines.push(`\u2022 peak windows: ${formatDeepSeekPeakWindows(now)}`);
	}
	if (typeof options.fetchedAt === "number" && Number.isFinite(options.fetchedAt) && options.fetchedAt > 0) {
		lines.push(`Updated ${fetchAgeLabel(options.fetchedAt, now)}`);
	}
	return lines.join("\n");
}
