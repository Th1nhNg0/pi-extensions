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
