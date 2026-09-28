/** Claude (Pro/Max) subscription usage: credentials, API response contract, normalization. */
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asRecord } from "../shared/record-guards.ts";
import { MissingCredentialError, envValue, readStoredCredential } from "./credentials.ts";
import { normalizePercent, normalizeUsageData } from "./usage-cache.ts";
import type { UsageData } from "./usage-cache.ts";

/** One rate-limit bucket from `GET /api/oauth/usage`; utilization is a 0–100 percentage. */
export interface ClaudeUsageBucket {
	utilization?: number | null;
	resets_at?: string | null;
}

export interface ClaudeUsageResponse {
	five_hour?: ClaudeUsageBucket | null;
	seven_day?: ClaudeUsageBucket | null;
	seven_day_opus?: ClaudeUsageBucket | null;
	seven_day_sonnet?: ClaudeUsageBucket | null;
	extra_usage?: { is_enabled?: boolean; utilization?: number | null } | null;
}

/** Response bucket → window key used by the footer and the detailed readout. */
const CLAUDE_BUCKETS = [
	["five_hour", "5h"],
	["seven_day", "weekly"],
	["seven_day_opus", "weekly-opus"],
	["seven_day_sonnet", "weekly-sonnet"],
] as const;

export function parseClaudeUsage(json: ClaudeUsageResponse, plan?: string): UsageData {
	const windows: Record<string, number> = {};
	const resets: Record<string, number> = {};
	for (const [field, key] of CLAUDE_BUCKETS) {
		const bucket = json[field];
		const percent = normalizePercent(bucket?.utilization);
		if (percent === undefined) continue;
		windows[key] = percent;
		const reset = typeof bucket?.resets_at === "string" ? Date.parse(bucket.resets_at) : NaN;
		if (Number.isFinite(reset)) resets[key] = reset;
	}
	// Pay-as-you-go overflow past the plan limits, when the account enabled it.
	const extra = json.extra_usage;
	const extraPercent = extra?.is_enabled ? normalizePercent(extra.utilization) : undefined;
	if (extraPercent !== undefined) windows.extra = extraPercent;

	const normalized = normalizeUsageData({ windows, plan, resets });
	if (!normalized || Object.keys(normalized.windows).length === 0) {
		throw new Error("no usage data");
	}
	return normalized;
}

export interface ClaudeCredential {
	access: string;
	/** Subscription tier when the source records it (Claude Code does: "pro", "max", …). */
	plan?: string;
}

/** Claude Code's credential file: `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/`. */
export function claudeCodeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
	return path.join(dir, ".credentials.json");
}

/**
 * Only subscription OAuth tokens (`sk-ant-oat…`) have plan usage; an API key
 * bills per token and has no windows to show.
 */
function isOAuthToken(token: string): boolean {
	return token.startsWith("sk-ant-oat");
}

/**
 * Resolve a Claude subscription token. Order: an explicit OAuth token in the
 * environment, Pi's own `anthropic` OAuth login (auth.json), then Claude
 * Code's login. Tokens are never refreshed here: both Pi and Claude Code
 * rotate the refresh token on use, so refreshing from a status line would
 * sign them out. An expired token is reported as unavailable until its owner
 * refreshes it on the next model request.
 */
export function resolveClaudeCredential(
	now = Date.now(),
	env: NodeJS.ProcessEnv = process.env,
	claudeCodePath = claudeCodeCredentialsPath(env),
): ClaudeCredential {
	const fromEnv = envValue(["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"], env);
	if (fromEnv) return { access: fromEnv };
	const keyLike = envValue(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"], env);
	if (keyLike && isOAuthToken(keyLike)) return { access: keyLike };

	let expired = false;
	const stored = readStoredCredential("anthropic");
	if (stored?.type === "oauth" && stored.access) {
		if (typeof stored.expires !== "number" || stored.expires > now) {
			return { access: stored.access };
		}
		expired = true;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(claudeCodePath, "utf8"));
	} catch {
		raw = undefined;
	}
	const oauth = asRecord(asRecord(raw)?.claudeAiOauth);
	const access = typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
	if (access) {
		const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
		if (expiresAt === undefined || expiresAt > now) {
			const plan = typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : undefined;
			return { access, ...(plan ? { plan } : {}) };
		}
		expired = true;
	}

	throw new MissingCredentialError(
		expired
			? "Claude OAuth token expired (Pi or Claude Code refreshes it on the next request)"
			: "no Claude subscription login (Pi /login anthropic, Claude Code, or ANTHROPIC_OAUTH_TOKEN)",
	);
}
