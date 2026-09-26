/** Reset-aware refresh timing policy, independent of the Pi event lifecycle. */
import { earliestReset } from "./usage-windows.ts";
import type { UsageData } from "./usage-cache.ts";

export const INTERVAL_MS = 5 * 60 * 1000; // idle refresh fallback
export const COOLDOWN_MS = 60 * 1000; // min gap between real fetches (event pokes)
export const MIN_FETCH_GAP_MS = 10_000; // absolute floor between API hits
const ERROR_BACKOFF_BASE_MS = 20_000; // first failed retry waits 20s…
const ERROR_BACKOFF_CAP_MS = 30 * 60 * 1000; // …capped at 30 min
const RESET_CATCH_DELAY_MS = 5_000; // refetch shortly after a window flips
const JITTER_RATIO = 0.2; // ±20%, avoid lockstep with other instances

export interface RefreshScheduleState {
	failStreak: number;
	lastFetch: number;
	lastData: UsageData | undefined;
}

/** ±JITTER_RATIO randomization so timers don't line up across instances. */
function jitter(ms: number): number {
	return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER_RATIO));
}

/**
 * Next delay until the next fetch: exponential backoff while the API is
 * failing; otherwise wake right after the nearest reset flips, or fall
 * back to the idle interval.
 */
export function nextDelay(
	state: RefreshScheduleState,
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
