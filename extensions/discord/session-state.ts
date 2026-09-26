/** Session usage values and shared in-memory registry contracts. */
import type { PresenceAction, PresencePhase } from "./actions.ts";

import { asRecord } from "../shared/record-guards.ts";
export { asRecord };
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost?: number;
	/** False when at least one usage record did not include pricing. */
	costComplete: boolean;
}

export interface ContextSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface SessionRecord {
	sessionId: string;
	projectName: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	phase: PresencePhase;
	action?: PresenceAction;
	startedAt: number;
	lastSeenAt: number;
	usage: UsageTotals;
	context?: ContextSnapshot;
	activeSubagents?: number;
	isSubagent?: boolean;
}

/** Check whether a session record belongs to a subagent child rather than a main session. */
export function isSubagentRecord(record: SessionRecord): boolean {
	if (record.isSubagent === true) return true;
	const pName = record.projectName.toLowerCase();
	const sId = record.sessionId.toLowerCase();
	if (pName.includes("pi-worktree-") || sId.includes("pi-worktree-")) return true;
	if (
		pName.includes("/.pi/subagents/") ||
		pName.includes("\\.pi\\subagents\\") ||
		sId.includes("/.pi/subagents/") ||
		sId.includes("\\.pi\\subagents\\")
	) {
		return true;
	}
	return false;
}

export interface PresenceState {
	version: 1;
	publisherId?: string;
	publisherGeneration: number;
	sessions: Record<string, SessionRecord>;
	updatedAt: number;
}

export type AssertLockOwnership = () => Promise<void>;

export interface PresenceStateStore {
	upsert(record: SessionRecord): Promise<PresenceState>;
	remove(sessionId: string): Promise<PresenceState>;
	read(): Promise<PresenceState>;
	withPublisherLock<T>(
		sessionId: string,
		publisherGeneration: number,
		operation: (assertOwnership: AssertLockOwnership) => Promise<T>,
	): Promise<T | undefined>;
}


export function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function emptyUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		costComplete: true,
	};
}

export function normalizeContextUsage(
	value: unknown,
): ContextSnapshot | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const contextWindow = finiteNonNegative(record.contextWindow);
	if (contextWindow === undefined) return undefined;
	const tokensValue = record.tokens;
	const percentValue = record.percent;
	const percent =
		percentValue === null ? null : (finiteNumber(percentValue) ?? null);
	return {
		tokens:
			tokensValue === null ? null : (finiteNonNegative(tokensValue) ?? null),
		contextWindow,
		percent: percent === null ? null : Math.min(100, Math.max(0, percent)),
	};
}

export function cloneUsage(usage: UsageTotals): UsageTotals {
	return { ...usage };
}

export function cloneRecord(record: SessionRecord): SessionRecord {
	return {
		...record,
		usage: cloneUsage(record.usage),
		context: record.context ? { ...record.context } : undefined,
	};
}
