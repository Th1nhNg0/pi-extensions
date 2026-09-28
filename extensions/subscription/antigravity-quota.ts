/** Antigravity quota-summary response shape and usage-window decoding. */
export interface AntigravityQuotaSummary {
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
}

export interface AntigravityQuotaUsage {
	windows: Record<string, number>;
	resets: Record<string, number>;
}

export function parseAntigravityQuota(quotaJson: AntigravityQuotaSummary): AntigravityQuotaUsage {
	const windows: Record<string, number> = {};
	const resets: Record<string, number> = {};
	for (const group of quotaJson.groups || []) {
		for (const bucket of group.buckets || []) {
			const key = bucket.bucketId || bucket.window;
			if (!key) continue;
			if (
				typeof bucket.remainingFraction === "number" &&
				Number.isFinite(bucket.remainingFraction)
			) {
				const remaining = Math.min(1, Math.max(0, bucket.remainingFraction));
				windows[key] = Math.round((1 - remaining) * 100);
			}
			if (bucket.resetTime) {
				const reset = Date.parse(bucket.resetTime);
				if (!Number.isNaN(reset)) resets[key] = reset;
			}
		}
	}
	if (Object.keys(windows).length === 0) throw new Error("no usage data");
	return { windows, resets };
}
