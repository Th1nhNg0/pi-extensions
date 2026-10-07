/** Stored provider credential reading and missing-credential classification. */
import fs from "node:fs";
import { agentFilePath } from "../shared/command-kit.ts";

interface ApiKeyCredential {
	type: "api_key";
	key: string;
}

interface OAuthCredential {
	type: "oauth";
	access: string;
	refresh?: string;
	expires?: number;
}

export type StoredCredential = ApiKeyCredential | OAuthCredential;

/**
 * Thrown when no usable credential (API key or OAuth token) exists for the
 * account. Kept distinct from real fetch failures so `/usage refresh` can
 * report a provider as unavailable instead of failed/retried.
 */
export class MissingCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MissingCredentialError";
	}
}

export function readStoredCredential(
	providerId: string,
	authPath = agentFilePath("auth.json"),
): StoredCredential | undefined {
	try {
		const raw = fs.readFileSync(authPath, "utf8");
		const data = JSON.parse(raw) as Record<string, StoredCredential>;
		return data?.[providerId];
	} catch {
		return undefined;
	}
}

/** First non-empty (trimmed) value among the given environment variables. */
export function envValue(
	names: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

/**
 * An API key from the first set env variable, else the provider's stored
 * `api_key` credential. Throws MissingCredentialError when neither exists.
 */
export function resolveApiKey(
	providerId: string,
	envNames: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): string {
	const fromEnv = envValue(envNames, env);
	if (fromEnv) return fromEnv;
	const cred = readStoredCredential(providerId);
	if (cred?.type === "api_key" && cred.key) return cred.key;
	throw new MissingCredentialError(`no API key (${envNames.join(" / ")} or auth.json)`);
}

/** Environment variables each usage provider reads its credential from, in priority order. */
export const USAGE_CREDENTIAL_ENV = {
	"opencode-go": ["OPENCODE_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	"openai-codex": ["OPENAI_CODEX_TOKEN", "CODEX_ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN"],
	antigravity: ["ANTIGRAVITY_TOKEN", "ANTIGRAVITY_API_KEY"],
} as const satisfies Record<string, readonly string[]>;

/** Whether a usage provider has credentials configured, without making a request. */
export function hasUsageCredential(providerId: string): boolean {
	// The unified OpenAI provider also supports API keys, which are not ChatGPT plans.
	// Its new OAuth grant must stay separate from the legacy Codex token/env aliases.
	if (providerId === "openai") {
		const credential = readStoredCredential(providerId);
		return (
			credential?.type === "oauth" &&
			typeof credential.access === "string" &&
			Boolean(credential.access.trim())
		);
	}
	const envNames: Record<string, readonly string[]> = USAGE_CREDENTIAL_ENV;
	const names = envNames[providerId];
	if (!names) return false;
	if (envValue(names)) return true;
	const credential = readStoredCredential(providerId);
	if (providerId === "openai-codex" || providerId === "antigravity") {
		return (
			credential?.type === "oauth" &&
			Boolean(
				credential.access?.trim() || (providerId === "antigravity" && credential.refresh?.trim()),
			)
		);
	}
	return credential?.type === "api_key" && Boolean(credential.key?.trim());
}
