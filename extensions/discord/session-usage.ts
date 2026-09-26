/** Pi session token/cost accounting and its compact presentation helpers. */
import {
	asRecord,
	emptyUsageTotals,
	finiteNonNegative,
	isSubagentRecord,
} from "./session-state.ts";
import type { SessionRecord, UsageTotals } from "./session-state.ts";

export interface UsageDelta {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
	cost?: number;
}

/** Extract Pi assistant/tool usage without depending on internal message types. */
export function extractUsage(message: unknown): UsageDelta | undefined {
	const messageRecord = asRecord(message);
	const usage = asRecord(messageRecord?.usage);
	if (!usage) return undefined;

	const input = finiteNonNegative(usage.input);
	const output = finiteNonNegative(usage.output);
	const cacheRead = finiteNonNegative(usage.cacheRead);
	const cacheWrite = finiteNonNegative(usage.cacheWrite);
	const explicitTotal = finiteNonNegative(usage.total ?? usage.totalTokens);
	const total =
		explicitTotal ??
		(input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
	const costRecord = asRecord(usage.cost);
	const cost =
		finiteNonNegative(costRecord?.total) ?? finiteNonNegative(usage.cost);

	if (
		input === undefined &&
		output === undefined &&
		cacheRead === undefined &&
		cacheWrite === undefined &&
		explicitTotal === undefined &&
		cost === undefined
	) {
		return undefined;
	}

	return { input, output, cacheRead, cacheWrite, total, cost };
}

export function mergeUsageTotals(
	base: UsageTotals,
	delta: UsageDelta,
): UsageTotals {
	const hasCost = delta.cost !== undefined;
	const deltaTotal =
		delta.total ??
		(delta.input ?? 0) +
			(delta.output ?? 0) +
			(delta.cacheRead ?? 0) +
			(delta.cacheWrite ?? 0);
	return {
		input: base.input + (delta.input ?? 0),
		output: base.output + (delta.output ?? 0),
		cacheRead: base.cacheRead + (delta.cacheRead ?? 0),
		cacheWrite: base.cacheWrite + (delta.cacheWrite ?? 0),
		total: base.total + deltaTotal,
		cost: delta.cost === undefined ? base.cost : (base.cost ?? 0) + delta.cost,
		costComplete: base.costComplete && hasCost,
	};
}

export function collectUsageFromEntries(
	entries: readonly unknown[],
): UsageTotals {
	let totals = emptyUsageTotals();
	for (const entry of entries) {
		const record = asRecord(entry);
		if (!record) continue;
		let delta: UsageDelta | undefined;
		if (record.type === "message") delta = extractUsage(record.message);
		else if (record.type === "compaction" || record.type === "branch_summary") {
			delta = extractUsage(record);
		}
		if (delta) totals = mergeUsageTotals(totals, delta);
	}
	return totals;
}

export interface AggregateSummary {
	usage: UsageTotals;
	projectCount: number;
	startTimestamp: number;
	subagentCount?: number;
}

export function summarizeRecords(records: readonly SessionRecord[]): AggregateSummary {
	const usage = emptyUsageTotals();
	const projects = new Set<string>();
	let startTimestamp = Number.POSITIVE_INFINITY;
	let subagentCount = 0;
	for (const record of records) {
		if (isSubagentRecord(record)) continue;
		projects.add(record.projectName);
		startTimestamp = Math.min(startTimestamp, record.startedAt);
		usage.input += record.usage.input;
		usage.output += record.usage.output;
		usage.cacheRead += record.usage.cacheRead;
		usage.cacheWrite += record.usage.cacheWrite;
		usage.total += record.usage.total;
		if (record.usage.cost !== undefined)
			usage.cost = (usage.cost ?? 0) + record.usage.cost;
		usage.costComplete =
			usage.costComplete &&
			record.usage.costComplete &&
			record.usage.cost !== undefined;
		subagentCount += record.activeSubagents ?? 0;
	}
	return {
		usage,
		projectCount: projects.size,
		startTimestamp: Number.isFinite(startTimestamp) ? startTimestamp : Date.now(),
		subagentCount,
	};
}

export function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	}
	return Math.round(tokens).toString();
}

export function formatCost(
	usage: Pick<UsageTotals, "cost" | "costComplete">,
): string {
	if (usage.cost === undefined) return "cost n/a";
	const prefix = usage.costComplete ? "$" : "~$";
	return `${prefix}${usage.cost.toFixed(2)}`;
}
