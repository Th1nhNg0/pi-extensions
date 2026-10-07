/** Antigravity: quota-summary decoding, OAuth token refresh, and the provider config. */
import {
	MissingCredentialError,
	USAGE_CREDENTIAL_ENV,
	envValue,
	readStoredCredential,
} from "./credentials.ts";
import { fetchJson, requestSignal } from "./http.ts";
import type { PolledProviderCfg } from "./provider-config.ts";
import { joinParts, labeledWindow } from "./rendering.ts";
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
const RETRYABLE_ANTIGRAVITY_STATUSES = new Set([403, 404, 429, 500, 502, 503, 504]);

/** Match pi-antigravity's endpoint order so quota reads use the same pool. */
export function antigravityEndpointCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
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
	const data = await fetchJson<{ access_token?: unknown; expires_in?: unknown }>(
		"https://oauth2.googleapis.com/token",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: process.env.ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_CLIENT_ID,
				client_secret: process.env.ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_CLIENT_SECRET,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}).toString(),
		},
		signal,
		"token refresh ",
	);
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
export const antigravityCfg: PolledProviderCfg = {
	id: "antigravity",
	async fetchUsage(signal?: AbortSignal) {
		let access = envValue(USAGE_CREDENTIAL_ENV.antigravity);
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

		if (refreshToken && (!access || (expires > 0 && Date.now() >= expires - 60_000))) {
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
			"User-Agent": process.env.ANTIGRAVITY_USER_AGENT || "antigravity/1.15.8 windows/amd64",
			"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
			"Client-Metadata": JSON.stringify({
				ideType: "ANTIGRAVITY",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			}),
		};

		async function queryQuota(token: string): Promise<{ response: Response; endpoint: string }> {
			let lastResponse: Response | undefined;
			let lastEndpoint: string | undefined;
			let lastError: unknown;
			for (const endpoint of endpoints) {
				try {
					const response = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
						method: "POST",
						headers: { ...headers, Authorization: `Bearer ${token}` },
						body: JSON.stringify({}),
						signal: requestSignal(signal),
					});
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
		const quotaJson = (await resQuota.json()) as AntigravityQuotaSummary;
		const { windows, resets } = parseAntigravityQuota(quotaJson);
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
					signal: requestSignal(signal),
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
