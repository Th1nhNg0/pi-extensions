/** Usage reset formatting and provider billing-window calculations. */
import type { UsageData } from "./usage-cache.ts";

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

/** `YYYY-MM-DD HH:MM UTC` for an epoch timestamp; `unknown time` if invalid. */
export function utcStamp(ms: number): string {
	if (!Number.isFinite(ms)) return "unknown time";
	try {
		return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
	} catch {
		return "unknown time";
	}
}

/**
 * DeepSeek bills on a UTC clock: two peak windows on weekdays, with a 50%
 * off-peak discount during every other hour. Weekends are off-peak in full.
 * Windows are stored as UTC minutes from midnight so they stay correct across
 * DST changes.
 */
export const DEEPSEEK_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[1 * 60, 4 * 60], // 01:00 - 04:00 UTC
	[6 * 60, 10 * 60], // 06:00 - 10:00 UTC
];

/** Peak billing applies Monday–Friday (UTC weekday); weekends never bill peak. */
export function isDeepSeekPeakDay(ms: number): boolean {
	const day = new Date(ms).getUTCDay();
	return day !== 0 && day !== 6;
}

/** Off-peak stretches at least this long also show an absolute resume time. */
const DEEPSEEK_LONG_OFFPEAK_MS = 86_400_000;

/**
 * Peak-hour state for DeepSeek's UTC billing windows. `windowStartMs` and
 * `windowEndMs` describe the active window while peak, or the next weekday
 * window while off-peak, so callers can render a local range without
 * re-deriving it.
 */
export interface DeepSeekPeakInfo {
	isPeak: boolean;
	nextFlipMs: number;
	windowStartMs: number;
	windowEndMs: number;
	/** Set while off-peak because the current UTC day is Saturday or Sunday. */
	reason?: "weekend";
}

/** Local calendar-day index, used to mark windows that cross local midnight. */
function localDayIndex(ms: number): number {
	return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / 86_400_000);
}

/** `HH:MM` in local time, ` +1`/` -1` when the edge lands after/before `referenceDay`. */
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

/**
 * UTC midnight of the day whose local clock times the peak windows render
 * against: today when it is a weekday, otherwise the next weekday. Anchoring a
 * weekend to the coming weekday keeps the local ranges from describing a day
 * that never bills peak, and keeps them correct across a DST change.
 */
function deepSeekWindowAnchor(now: number): number {
	const d = new Date(now);
	const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	for (let offset = 0; offset <= 7; offset++) {
		const midnight = today + offset * 86_400_000;
		if (isDeepSeekPeakDay(midnight)) return midnight;
	}
	return today;
}

/** Both peak windows as local ranges, plus their canonical UTC ranges. */
export function formatDeepSeekPeakWindows(now = Date.now()): string {
	const anchor = deepSeekWindowAnchor(now);
	const local = DEEPSEEK_PEAK_WINDOWS.map(([start, end]) =>
		formatLocalTimeRange(anchor + start * 60_000, anchor + end * 60_000, anchor),
	).join(", ");
	const utc = DEEPSEEK_PEAK_WINDOWS.map(
		([start, end]) => `${utcClock(start)}–${utcClock(end)} UTC`,
	).join(", ");
	return `${local} (local) · ${utc} · Mon–Fri (UTC)`;
}

/**
 * Peak-hour state for DeepSeek's UTC billing windows at `now`. Peak runs
 * Monday–Friday only, so weekend off-peak resolves to the next weekday
 * window; `reason` marks the weekend case for callers that explain the wait.
 */
export function getDeepSeekPeakInfo(now = Date.now()): DeepSeekPeakInfo {
	const d = new Date(now);
	const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
	const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const weekend = !isDeepSeekPeakDay(now);

	if (!weekend) {
		for (const [start, end] of DEEPSEEK_PEAK_WINDOWS) {
			if (utcMins >= start && utcMins < end) {
				const windowStartMs = utcMidnight + start * 60_000;
				const windowEndMs = utcMidnight + end * 60_000;
				return { isPeak: true, nextFlipMs: windowEndMs, windowStartMs, windowEndMs };
			}
		}
	}

	// Off-peak: the next window on the nearest weekday, skipping the weekend.
	for (let offset = 0; offset <= 7; offset++) {
		const midnight = utcMidnight + offset * 86_400_000;
		if (!isDeepSeekPeakDay(midnight)) continue;
		for (const [start, end] of DEEPSEEK_PEAK_WINDOWS) {
			const windowStartMs = midnight + start * 60_000;
			if (windowStartMs <= now) continue;
			return {
				isPeak: false,
				nextFlipMs: windowStartMs,
				windowStartMs,
				windowEndMs: midnight + end * 60_000,
				...(weekend ? { reason: "weekend" as const } : {}),
			};
		}
	}

	// Unreachable with the current window table (a weekday always follows
	// within three days); kept so callers never see a non-finite countdown.
	const [start, end] = DEEPSEEK_PEAK_WINDOWS[0];
	const tomorrow = utcMidnight + 86_400_000;
	return {
		isPeak: false,
		nextFlipMs: tomorrow + start * 60_000,
		windowStartMs: tomorrow + start * 60_000,
		windowEndMs: tomorrow + end * 60_000,
		...(weekend ? { reason: "weekend" as const } : {}),
	};
}

/** True when the active provider/model bills on DeepSeek's peak-hour windows. */
export function usesDeepSeekPeakPricing(providerId?: string, modelId?: string): boolean {
	if (providerId === "deepseek") return true;
	return Boolean(modelId && /deepseek/i.test(modelId));
}

/**
 * Detailed off-peak line for the `/usage` readout: flip countdown, the weekend
 * reason when it applies, and — past a day — the absolute resume time.
 */
export function deepSeekOffPeakDetail(peak: DeepSeekPeakInfo, now: number): string {
	const reason = peak.reason ? ` (${peak.reason})` : "";
	const resume =
		peak.nextFlipMs - now >= DEEPSEEK_LONG_OFFPEAK_MS
			? ` — resumes ${utcStamp(peak.nextFlipMs)}`
			: "";
	return `Off-peak ${resetLabel(peak.nextFlipMs, now)} until peak${reason}${resume}`;
}

/** Theme-colored peak/off-peak tag with the weekend reason and countdown. */
export function deepSeekPeakTag(
	theme: { fg(color: string, text: string): string },
	now = Date.now(),
): string {
	const peak = getDeepSeekPeakInfo(now);
	if (peak.isPeak) return theme.fg("warning", `Peak ${resetLabel(peak.nextFlipMs, now)}`);
	const reason = peak.reason ? ` (${peak.reason})` : "";
	return theme.fg("dim", `Off-Peak ${resetLabel(peak.nextFlipMs, now)}${reason}`);
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
