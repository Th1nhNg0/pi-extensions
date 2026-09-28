/** Target resolution and user-facing summaries for `/usage refresh`. */

/** Result of one provider refresh: fresh data, reused cache, no credential for the account, or a real fetch failure. */
export type RefreshOutcome = "fetched" | "cached" | "skipped" | "failed";

export interface RefreshResult {
	id: string;
	outcome: RefreshOutcome;
}

/** Unambiguous short names accepted as `/usage refresh <target>` aliases. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	claude: "anthropic",
	"claude-code": "anthropic",
	opencode: "opencode-go",
	"opencode-zen": "opencode-go",
	zen: "opencode-go",
	codex: "openai-codex",
	openai: "openai-codex",
	antigravity: "antigravity",
	google: "antigravity",
	deepseek: "deepseek",
};

/** Resolve a refresh target against an ordered provider list. */
export function resolveRefreshTargets<T extends { id: string }>(
	arg: string,
	cfgs: readonly T[],
	activeProviderId?: string,
): T[] | undefined {
	const target = arg.trim().toLowerCase();
	if (!target || target === "all") return [...cfgs];
	if (target === "active") {
		const active = activeProviderId
			? cfgs.find((c) => c.id.toLowerCase() === activeProviderId.toLowerCase())
			: undefined;
		return active ? [active] : undefined;
	}
	const exact = cfgs.find((c) => c.id.toLowerCase() === target);
	if (exact) return [exact];
	const aliased = PROVIDER_ALIASES[target];
	if (!aliased) return undefined;
	const match = cfgs.find((c) => c.id === aliased);
	return match ? [match] : undefined;
}

/** Human-readable summary of a `/usage refresh` fan-out. */
export function formatRefreshNotice(results: readonly RefreshResult[]): string {
	if (results.length === 0) return "No usage providers to refresh";
	if (results.length === 1) {
		const { id, outcome } = results[0];
		switch (outcome) {
			case "fetched":
				return `Usage refreshed for ${id}`;
			case "cached":
				return `Usage refresh finished from cache for ${id}`;
			case "skipped":
				return `Usage refresh skipped for ${id} (no credentials)`;
			default:
				return `Usage refresh failed for ${id}`;
		}
	}
	const idsWith = (outcome: RefreshOutcome) =>
		results.filter((r) => r.outcome === outcome).map((r) => r.id);
	const fetched = idsWith("fetched");
	const cached = idsWith("cached");
	const skipped = idsWith("skipped");
	const failed = idsWith("failed");
	const parts: string[] = [];
	if (fetched.length === results.length) {
		parts.push(`Usage refreshed for all ${results.length} providers (${fetched.join(", ")})`);
	} else if (fetched.length > 0) {
		parts.push(`Usage refreshed for ${fetched.join(", ")}`);
	} else {
		parts.push("No usage data refreshed");
	}
	if (cached.length > 0) parts.push(`from cache: ${cached.join(", ")}`);
	if (skipped.length > 0) parts.push(`no credentials: ${skipped.join(", ")}`);
	if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
	return parts.join(" · ");
}
