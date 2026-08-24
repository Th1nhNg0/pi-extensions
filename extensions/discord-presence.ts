/**
 * Discord Rich Presence for Pi Coding Agent.
 *
 * The extension publishes one privacy-safe, aggregated activity for all active
 * Pi sessions. It never sends prompts, paths, filenames, commands, or tool
 * arguments. Each session contributes project/model/state/usage metadata to a
 * shared registry; one elected session owns the Discord RPC connection.
 *
 * A public default Discord application ID is included; PI_DISCORD_CLIENT_ID
 * can override it. Discord's desktop client must be running. Connection and
 * registry failures are non-fatal and are retried in the background.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { Client, type SetActivity } from "@xhayper/discord-rpc";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLIENT_ID_ENV = "PI_DISCORD_CLIENT_ID";
const DEFAULT_CLIENT_ID = "1541350417143955466";
const DEFAULT_STATE_PATH = join(
	os.homedir(),
	".pi",
	"agent",
	"discord-presence-state.json",
);
const MAX_ACTIVITY_TEXT_LENGTH = 128;
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_SESSION_MS = 30_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 15_000;
const LOCK_RETRY_MS = 25;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 5 * 60_000;
const RPC_WRITE_TIMEOUT_MS = 10_000;

type GitCommandResult = {
	stdout: string;
	code: number;
};

export type PresencePhase = "thinking" | "tools" | "idle";

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

export interface UsageDelta {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
	cost?: number;
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
	phase: PresencePhase;
	startedAt: number;
	lastSeenAt: number;
	usage: UsageTotals;
	context?: ContextSnapshot;
}

export interface PresenceState {
	version: 1;
	publisherId?: string;
	publisherGeneration: number;
	sessions: Record<string, SessionRecord>;
	updatedAt: number;
}

export type PresenceActivity = SetActivity & {
	details: string;
	state: string;
	startTimestamp: number;
	instance: true;
};

export type PresenceStatus =
	| "not-started"
	| "starting"
	| "connecting"
	| "connected"
	| "standby"
	| "reconnecting"
	| "disabled"
	| "stopped";

export interface DiscordPresenceTransport {
	isConnected(): boolean;
	connect(): Promise<void>;
	setActivity(activity: SetActivity): Promise<void>;
	clearActivity(): Promise<void>;
	close(): Promise<void>;
	onDisconnected?(handler: () => void): () => void;
}

type AssertLockOwnership = () => Promise<void>;

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

export interface PresenceManagerOptions {
	clientId: string;
	projectName: string;
	provider?: string;
	modelId?: string;
	startedAt?: number;
	initialUsage?: UsageTotals;
	initialContext?: ContextSnapshot;
	createTransport?: (clientId: string) => DiscordPresenceTransport;
	stateStore?: PresenceStateStore;
	logger?: (message: string) => void;
	now?: () => number;
	heartbeatMs?: number;
	retryBaseMs?: number;
	retryCapMs?: number;
}

function defaultLogger(message: string): void {
	process.stderr.write(`${message}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
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

export function normalizeContextUsage(
	value: unknown,
): ContextSnapshot | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const contextWindow = finiteNonNegative(record.contextWindow);
	if (contextWindow === undefined) return undefined;
	const tokensValue = record.tokens;
	const percentValue = record.percent;
	return {
		tokens:
			tokensValue === null ? null : (finiteNonNegative(tokensValue) ?? null),
		contextWindow,
		percent: percentValue === null ? null : (finiteNumber(percentValue) ?? null),
	};
}

function sumUsage(records: readonly SessionRecord[]): UsageTotals {
	let totals = emptyUsageTotals();
	for (const record of records) {
		totals = {
			input: totals.input + record.usage.input,
			output: totals.output + record.usage.output,
			cacheRead: totals.cacheRead + record.usage.cacheRead,
			cacheWrite: totals.cacheWrite + record.usage.cacheWrite,
			total: totals.total + record.usage.total,
			cost:
				totals.cost === undefined || record.usage.cost === undefined
					? (totals.cost ?? record.usage.cost)
					: totals.cost + record.usage.cost,
			costComplete:
				totals.costComplete &&
				record.usage.costComplete &&
				record.usage.cost !== undefined,
		};
	}
	return totals;
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

function truncateText(
	value: string,
	maxLength = MAX_ACTIVITY_TEXT_LENGTH,
): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Return a basename for both POSIX and Windows paths, regardless of host OS. */
export function basenameForAnyPlatform(value: string): string {
	const normalized = value.trim().replace(/[\\/]+$/, "");
	if (!normalized) return "project";
	const separator = Math.max(
		normalized.lastIndexOf("/"),
		normalized.lastIndexOf("\\"),
	);
	return normalized.slice(separator + 1) || "project";
}

export function parseClientId(value: string | undefined): string | undefined {
	const clientId = value?.trim();
	return clientId && /^\d{17,20}$/.test(clientId) ? clientId : undefined;
}

export function formatModelLabel(provider?: string, modelId?: string): string {
	const label =
		provider && modelId
			? `${provider}/${modelId}`
			: (modelId ?? provider ?? "Pi");
	return truncateText(label, 96);
}

function formatPresenceModelLabel(provider?: string, modelId?: string): string {
	return truncateText(modelId ?? provider ?? "Pi", 48);
}

export function formatPhase(phase: PresencePhase): string {
	switch (phase) {
		case "thinking":
			return "Thinking";
		case "tools":
			return "Using tools";
		case "idle":
			return "Idle";
		default:
			return "Idle";
	}
}

export interface PresenceSnapshot {
	projectName: string;
	provider?: string;
	modelId?: string;
	phase: PresencePhase;
	startedAt: number;
	usage?: UsageTotals;
	context?: ContextSnapshot;
}

function snapshotRecord(snapshot: PresenceSnapshot): SessionRecord {
	return {
		sessionId: "current",
		projectName: snapshot.projectName,
		provider: snapshot.provider,
		modelId: snapshot.modelId,
		phase: snapshot.phase,
		startedAt: snapshot.startedAt,
		lastSeenAt: snapshot.startedAt,
		usage: snapshot.usage ?? emptyUsageTotals(),
		context: snapshot.context,
	};
}

function compareSessions(a: SessionRecord, b: SessionRecord): number {
	return (
		b.lastSeenAt - a.lastSeenAt ||
		a.startedAt - b.startedAt ||
		a.sessionId.localeCompare(b.sessionId)
	);
}

function orderedSessions(state: PresenceState): SessionRecord[] {
	const records = Object.values(state.sessions);
	const publisher = state.publisherId
		? state.sessions[state.publisherId]
		: undefined;
	return records.sort((a, b) => {
		const aActive = a.phase !== "idle";
		const bActive = b.phase !== "idle";
		if (aActive !== bActive) return aActive ? -1 : 1;
		if (!aActive && a.sessionId === publisher?.sessionId) return -1;
		if (!bActive && b.sessionId === publisher?.sessionId) return 1;
		return compareSessions(a, b);
	});
}

function projectCount(records: readonly SessionRecord[]): number {
	return new Set(records.map((record) => record.projectName)).size;
}

export function buildAggregateActivity(state: PresenceState): PresenceActivity {
	const records = orderedSessions(state);
	if (records.length === 0) {
		return {
			details: "0 Pi sessions · 0 tok · cost n/a",
			state: "Pi · Idle",
			startTimestamp: Date.now(),
			instance: true,
		};
	}

	const primary = records[0];
	const totalUsage = sumUsage(records);
	const sessionLabel = `${records.length} session${records.length === 1 ? "" : "s"}`;
	const details = `${sessionLabel} · ${formatTokenCount(totalUsage.total)} tok · ${formatCost(totalUsage)}`;
	const projects = projectCount(records);
	const projectLabel = `${projects} project${projects === 1 ? "" : "s"}`;
	const activityState = `${formatPhase(primary.phase)} · ${formatPresenceModelLabel(primary.provider, primary.modelId)} · ${projectLabel}`;
	const startTimestamp = Math.min(...records.map((record) => record.startedAt));

	return {
		details: truncateText(details),
		state: truncateText(activityState),
		startTimestamp,
		instance: true,
	};
}

export function buildActivity(snapshot: PresenceSnapshot): PresenceActivity {
	return buildAggregateActivity({
		version: 1,
		publisherId: "current",
		publisherGeneration: 1,
		sessions: { current: snapshotRecord(snapshot) },
		updatedAt: snapshot.startedAt,
	});
}

/** Resolve the Git repository basename, falling back to the current cwd. */
export async function resolveProjectName(
	cwd: string,
	runGit?: () => Promise<GitCommandResult>,
): Promise<string> {
	if (runGit) {
		try {
			const result = await runGit();
			if (result.code === 0 && result.stdout.trim()) {
				return basenameForAnyPlatform(result.stdout);
			}
		} catch {
			// Not a Git repository, or Git is unavailable. Use the cwd below.
		}
	}
	return basenameForAnyPlatform(cwd);
}

function emptyState(now = Date.now()): PresenceState {
	return {
		version: 1,
		publisherGeneration: 0,
		sessions: {},
		updatedAt: now,
	};
}

function cloneUsage(usage: UsageTotals): UsageTotals {
	return { ...usage };
}

function cloneRecord(record: SessionRecord): SessionRecord {
	return {
		...record,
		usage: cloneUsage(record.usage),
		context: record.context ? { ...record.context } : undefined,
	};
}

function cloneState(state: PresenceState): PresenceState {
	return {
		version: 1,
		publisherId: state.publisherId,
		publisherGeneration: state.publisherGeneration,
		updatedAt: state.updatedAt,
		sessions: Object.fromEntries(
			Object.entries(state.sessions).map(([id, record]) => [
				id,
				cloneRecord(record),
			]),
		),
	};
}

function parseUsage(value: unknown): UsageTotals | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const input = finiteNonNegative(record.input);
	const output = finiteNonNegative(record.output);
	const cacheRead = finiteNonNegative(record.cacheRead);
	const cacheWrite = finiteNonNegative(record.cacheWrite);
	const total = finiteNonNegative(record.total);
	if (
		input === undefined ||
		output === undefined ||
		cacheRead === undefined ||
		cacheWrite === undefined ||
		total === undefined
	) {
		return undefined;
	}
	const cost = finiteNonNegative(record.cost);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total,
		cost,
		costComplete: record.costComplete !== false && cost !== undefined,
	};
}

function parseContext(value: unknown): ContextSnapshot | undefined {
	return normalizeContextUsage(value);
}

function parseSessionRecord(value: unknown): SessionRecord | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const sessionId =
		typeof record.sessionId === "string" ? record.sessionId : undefined;
	const projectName =
		typeof record.projectName === "string" ? record.projectName : undefined;
	const phase = record.phase;
	const startedAt = finiteNumber(record.startedAt);
	const lastSeenAt = finiteNumber(record.lastSeenAt);
	const usage = parseUsage(record.usage);
	if (
		!sessionId ||
		projectName === undefined ||
		(startedAt ?? -1) < 0 ||
		(lastSeenAt ?? -1) < 0 ||
		!usage ||
		(phase !== "thinking" && phase !== "tools" && phase !== "idle")
	) {
		return undefined;
	}
	return {
		sessionId,
		projectName,
		provider: typeof record.provider === "string" ? record.provider : undefined,
		modelId: typeof record.modelId === "string" ? record.modelId : undefined,
		phase,
		startedAt: startedAt as number,
		lastSeenAt: lastSeenAt as number,
		usage,
		context: parseContext(record.context),
	};
}

function pruneState(
	state: PresenceState,
	now: number,
	staleAfterMs: number,
): PresenceState {
	const previousPublisherId = state.publisherId;
	for (const [sessionId, record] of Object.entries(state.sessions)) {
		if (now - record.lastSeenAt > staleAfterMs) delete state.sessions[sessionId];
	}
	if (state.publisherId && !state.sessions[state.publisherId]) {
		state.publisherId = undefined;
	}
	if (!state.publisherId) {
		const next = Object.values(state.sessions).sort(
			(a, b) =>
				a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId),
		)[0];
		state.publisherId = next?.sessionId;
	}
	if (state.publisherId !== previousPublisherId) state.publisherGeneration += 1;
	return state;
}

function parseState(
	raw: unknown,
	now: number,
	staleAfterMs: number,
): PresenceState {
	const record = asRecord(raw);
	const sessionsRecord = asRecord(record?.sessions);
	const sessions: Record<string, SessionRecord> = {};
	if (sessionsRecord) {
		for (const [sessionId, value] of Object.entries(sessionsRecord)) {
			const session = parseSessionRecord(value);
			if (session && session.sessionId === sessionId)
				sessions[sessionId] = session;
		}
	}
	const state: PresenceState = {
		version: 1,
		publisherId:
			typeof record?.publisherId === "string" ? record.publisherId : undefined,
		publisherGeneration: finiteNonNegative(record?.publisherGeneration) ?? 0,
		sessions,
		updatedAt: finiteNumber(record?.updatedAt) ?? now,
	};
	return pruneState(state, now, staleAfterMs);
}

async function readStateFile(
	filePath: string,
	now: number,
	staleAfterMs: number,
): Promise<PresenceState> {
	try {
		const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		return parseState(raw, now, staleAfterMs);
	} catch {
		return emptyState(now);
	}
}

async function writeStateFile(
	filePath: string,
	state: PresenceState,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const contents = JSON.stringify(state, null, 2);
	try {
		await writeFile(tempPath, contents, "utf8");
		try {
			await rename(tempPath, filePath);
		} catch {
			await writeFile(filePath, contents, "utf8");
		}
	} finally {
		try {
			await rm(tempPath, { force: true });
		} catch {
			// The temporary file may already have been renamed or removed.
		}
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("Discord RPC request timed out")),
			timeoutMs,
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

interface FileLockOptions {
	ownerToken?: string;
}

async function readLockOwner(markerPath: string): Promise<string | undefined> {
	try {
		return await readFile(markerPath, "utf8");
	} catch {
		return undefined;
	}
}

async function reclaimFileLock(
	lockPath: string,
	expectedOwnerToken: string | undefined,
): Promise<boolean> {
	const tombstone = `${lockPath}.reclaim.${randomUUID()}`;
	try {
		// Renaming the whole lock directory is the fencing operation. Verify
		// the owner token after the rename so a contender cannot clean up a
		// replacement lock that won the race while this one was stale.
		await rename(lockPath, tombstone);
	} catch {
		return false;
	}
	const actualOwnerToken = await readLockOwner(join(tombstone, "owner"));
	if (actualOwnerToken !== expectedOwnerToken) {
		try {
			await rename(tombstone, lockPath);
		} catch {
			// A replacement owner may have acquired the path already. Leave
			// the mismatched tombstone untouched rather than deleting it.
		}
		return false;
	}
	try {
		await rm(tombstone, { recursive: true, force: true });
	} catch {
		// Cleanup can be retried by the next lock operation.
	}
	return true;
}

async function releaseFileLock(
	lockPath: string,
	ownerToken: string,
): Promise<void> {
	await reclaimFileLock(lockPath, ownerToken);
}

async function withFileLock<T>(
	lockPath: string,
	operation: (assertOwnership: AssertLockOwnership) => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true });
	const markerPath = join(lockPath, "owner");
	const ownerToken = options.ownerToken ?? `${process.pid}:${randomUUID()}`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let acquired = false;
	while (!acquired) {
		let createdDirectory = false;
		try {
			await mkdir(lockPath);
			createdDirectory = true;
			await writeFile(markerPath, ownerToken, "utf8");
			acquired = true;
		} catch (error) {
			if (createdDirectory) {
				await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

			let shouldBreak = false;
			try {
				const lockStats = await stat(lockPath);
				// Do not rely on PID liveness here: Windows can reuse a PID after
				// the process that created this lock has exited.
				shouldBreak = Date.now() - lockStats.mtimeMs > LOCK_STALE_MS;
			} catch {
				// A concurrent owner may have released the lock.
			}
			if (shouldBreak) {
				await reclaimFileLock(lockPath, await readLockOwner(markerPath));
				continue;
			}
			if (Date.now() >= deadline) throw new Error("presence state lock timeout");
			await wait(LOCK_RETRY_MS);
		}
	}
	const assertOwnership: AssertLockOwnership = async () => {
		if ((await readLockOwner(markerPath)) !== ownerToken) {
			throw new Error("presence lock ownership lost");
		}
	};
	try {
		await assertOwnership();
		return await operation(assertOwnership);
	} finally {
		await releaseFileLock(lockPath, ownerToken);
	}
}

export interface FilePresenceStateStoreOptions {
	now?: () => number;
	staleAfterMs?: number;
}

/** Atomic, cross-process session registry with stale-session cleanup. */
export class FilePresenceStateStore implements PresenceStateStore {
	private readonly filePath: string;
	private readonly lockPath: string;
	private readonly publisherLockPath: string;
	private readonly now: () => number;
	private readonly staleAfterMs: number;

	constructor(
		filePath = DEFAULT_STATE_PATH,
		options: FilePresenceStateStoreOptions = {},
	) {
		this.filePath = filePath;
		this.lockPath = `${filePath}.lock`;
		this.publisherLockPath = `${filePath}.publisher.lock`;
		this.now = options.now ?? Date.now;
		this.staleAfterMs = options.staleAfterMs ?? STALE_SESSION_MS;
	}

	async upsert(record: SessionRecord): Promise<PresenceState> {
		return this.mutate((state, now) => {
			state.sessions[record.sessionId] = {
				...cloneRecord(record),
				lastSeenAt: now,
			};
		});
	}

	async remove(sessionId: string): Promise<PresenceState> {
		return this.mutate((state) => {
			delete state.sessions[sessionId];
			if (state.publisherId === sessionId) state.publisherId = undefined;
		});
	}

	async read(): Promise<PresenceState> {
		return readStateFile(this.filePath, this.now(), this.staleAfterMs);
	}

	async withPublisherLock<T>(
		sessionId: string,
		publisherGeneration: number,
		operation: (assertOwnership: AssertLockOwnership) => Promise<T>,
	): Promise<T | undefined> {
		const ownerToken = `${process.pid}:${randomUUID()}:${sessionId}:${publisherGeneration}`;
		return withFileLock(
			this.publisherLockPath,
			async (assertOwnership) => {
				const state = await this.read();
				if (
					state.publisherId !== sessionId ||
					state.publisherGeneration !== publisherGeneration
				) {
					return undefined;
				}
				return operation(assertOwnership);
			},
			{ ownerToken },
		);
	}

	private async mutate(
		mutation: (state: PresenceState, now: number) => void,
	): Promise<PresenceState> {
		return withFileLock(this.lockPath, async (assertStateLock) => {
			const now = this.now();
			const state = pruneState(
				await readStateFile(this.filePath, now, this.staleAfterMs),
				now,
				this.staleAfterMs,
			);
			const previousPublisherId = state.publisherId;
			const previousPublisherGeneration = state.publisherGeneration;
			mutation(state, now);
			pruneState(state, now, this.staleAfterMs);

			const persist = async (
				assertPublisherLock?: AssertLockOwnership,
			): Promise<PresenceState> => {
				await assertStateLock();
				await assertPublisherLock?.();
				state.updatedAt = now;
				await writeStateFile(this.filePath, state);
				return cloneState(state);
			};
			const publisherChanged =
				state.publisherId !== previousPublisherId ||
				state.publisherGeneration !== previousPublisherGeneration;
			if (!publisherChanged) return persist();

			// Publisher changes and Discord writes share this second lock. A
			// publisher cannot be elected away while its RPC write is in flight.
			return withFileLock(
				this.publisherLockPath,
				(assertPublisherLock) => persist(assertPublisherLock),
				{ ownerToken: `${process.pid}:${randomUUID()}:registry:${now}` },
			);
		});
	}
}

export function createDiscordPresenceTransport(
	clientId: string,
): DiscordPresenceTransport {
	const client = new Client({ clientId });
	const disconnectHandlers = new Set<() => void>();

	client.on("disconnected", () => {
		for (const handler of disconnectHandlers) handler();
	});

	return {
		isConnected: () => client.isConnected,
		connect: () => client.connect(),
		setActivity: async (activity) => {
			if (!client.user) throw new Error("Discord RPC user is not ready");
			await client.user.setActivity(activity);
		},
		clearActivity: async () => {
			if (client.user) await client.user.clearActivity();
		},
		close: () => client.destroy(),
		onDisconnected: (handler) => {
			disconnectHandlers.add(handler);
			return () => disconnectHandlers.delete(handler);
		},
	};
}

export class DiscordPresenceManager {
	private readonly sessionId = randomUUID();
	private readonly clientId: string;
	private readonly stateStore: PresenceStateStore;
	private readonly createTransport: (
		clientId: string,
	) => DiscordPresenceTransport;
	private readonly logger: (message: string) => void;
	private readonly now: () => number;
	private readonly heartbeatMs: number;
	private readonly retryBaseMs: number;
	private readonly retryCapMs: number;
	private readonly record: SessionRecord;

	private status: PresenceStatus = "not-started";
	private started = false;
	private disposed = false;
	private publisher = false;
	private publisherGeneration = 0;
	private transport: DiscordPresenceTransport | undefined;
	private removeDisconnectedListener: (() => void) | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryAttempt = 0;
	private connectionPromise: Promise<boolean> | undefined;
	private registryQueue: Promise<void> = Promise.resolve();
	private presenceQueue: Promise<void> = Promise.resolve();
	private outageWarningShown = false;
	private registryWarningShown = false;

	constructor(options: PresenceManagerOptions) {
		this.clientId = options.clientId;
		this.stateStore = options.stateStore ?? new FilePresenceStateStore();
		this.createTransport =
			options.createTransport ?? createDiscordPresenceTransport;
		this.logger = options.logger ?? defaultLogger;
		this.now = options.now ?? Date.now;
		this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
		this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
		this.retryCapMs = options.retryCapMs ?? RETRY_CAP_MS;
		const startedAt = options.startedAt ?? this.now();
		this.record = {
			sessionId: this.sessionId,
			projectName: options.projectName,
			provider: options.provider,
			modelId: options.modelId,
			phase: "idle",
			startedAt,
			lastSeenAt: startedAt,
			usage: cloneUsage(options.initialUsage ?? emptyUsageTotals()),
			context: options.initialContext ? { ...options.initialContext } : undefined,
		};
	}

	getSessionId(): string {
		return this.sessionId;
	}

	isPublisher(): boolean {
		return this.publisher;
	}

	getStatus(): PresenceStatus {
		return this.status;
	}

	getStatusText(): string {
		switch (this.status) {
			case "connected":
				return "connected (publisher)";
			case "connecting":
				return "connecting (publisher)";
			case "standby":
				return "standby (another session is publishing)";
			case "reconnecting":
				return "retrying";
			case "disabled":
				return "disabled";
			case "stopped":
				return "stopped";
			default:
				return "not started";
		}
	}

	async start(): Promise<void> {
		if (this.started || this.disposed) return;
		this.started = true;
		this.status = "starting";
		await this.enqueueRegistryUpdate();
		if (this.disposed) return;
		this.heartbeatTimer = setInterval(() => {
			void this.heartbeat();
		}, this.heartbeatMs);
		this.heartbeatTimer.unref?.();
		await this.refresh();
	}

	setModel(provider?: string, modelId?: string): Promise<void> {
		this.record.provider = provider;
		this.record.modelId = modelId;
		return this.enqueueRegistryUpdate();
	}

	setPhase(phase: PresencePhase): Promise<void> {
		this.record.phase = phase;
		return this.enqueueRegistryUpdate();
	}

	recordUsage(delta: UsageDelta): Promise<void> {
		this.record.usage = mergeUsageTotals(this.record.usage, delta);
		return this.enqueueRegistryUpdate();
	}

	setContextUsage(context: ContextSnapshot | undefined): Promise<void> {
		this.record.context = context ? { ...context } : undefined;
		return this.enqueueRegistryUpdate();
	}

	/** Force a state read; useful for diagnostics and deterministic tests. */
	async refresh(): Promise<void> {
		if (!this.started || this.disposed) return;
		try {
			await this.applyState(await this.stateStore.read(), true);
		} catch {
			this.warnRegistryFailure();
		}
	}

	async getDiagnosticText(): Promise<string> {
		let state: PresenceState;
		try {
			state = await this.stateStore.read();
		} catch {
			return `Discord presence: ${this.getStatusText()}\nSession registry unavailable.`;
		}
		const records = orderedSessions(state);
		const publisherLabel = state.publisherId
			? (state.sessions[state.publisherId]?.projectName ?? "unknown")
			: "none";
		const lines = [
			`Discord presence: ${this.getStatusText()}`,
			`Publisher: ${publisherLabel}`,
			`Sessions: ${records.length}`,
		];
		for (const record of records)
			lines.push(formatDiagnosticSession(record, this.now()));
		return lines.join("\n");
	}

	async stop(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.started = false;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.clearRetryTimer();
		await this.registryQueue.catch(() => undefined);
		await this.presenceQueue.catch(() => undefined);

		const wasPublisher = this.publisher;
		if (wasPublisher && this.transport) {
			try {
				await this.stateStore.withPublisherLock(
					this.sessionId,
					this.publisherGeneration,
					async (assertOwnership) => {
						const current = await this.stateStore.read();
						if (
							current.publisherId === this.sessionId &&
							Object.keys(current.sessions).length === 1
						) {
							try {
								await assertOwnership();
								if (this.transport) {
									await awaitWithTimeout(
										this.transport.clearActivity(),
										RPC_WRITE_TIMEOUT_MS,
									);
								}
							} catch {
								// Discord may already be unavailable.
							}
						}
					},
				);
			} catch {
				this.warnRegistryFailure();
			}
		}
		this.publisher = false;
		try {
			await this.stateStore.remove(this.sessionId);
		} catch {
			this.warnRegistryFailure();
		}

		await this.closeTransport();
		this.status = "stopped";
	}

	private async heartbeat(): Promise<void> {
		if (!this.started || this.disposed) return;
		await this.enqueueRegistryUpdate();
	}

	private enqueueRegistryUpdate(): Promise<void> {
		const previous = this.registryQueue;
		const next = (async () => {
			try {
				await previous;
			} catch {
				// A failed update must not block later heartbeats.
			}
			if (!this.started || this.disposed) return;
			this.record.lastSeenAt = this.now();
			try {
				const state = await this.stateStore.upsert(cloneRecord(this.record));
				this.registryWarningShown = false;
				await this.applyState(state, false);
			} catch {
				this.warnRegistryFailure();
			}
		})();
		this.registryQueue = next;
		return next;
	}

	private async applyState(
		state: PresenceState,
		waitForPresence: boolean,
	): Promise<void> {
		if (this.disposed) return;
		const shouldPublish = state.publisherId === this.sessionId;
		if (!shouldPublish) {
			this.publisher = false;
			this.clearRetryTimer();
			await this.closeTransport();
			this.status = "standby";
			return;
		}

		this.publisher = true;
		this.publisherGeneration = state.publisherGeneration;
		const publish = this.enqueuePresencePublish(state);
		if (waitForPresence) await publish;
	}

	private enqueuePresencePublish(state: PresenceState): Promise<void> {
		const previous = this.presenceQueue;
		const next = (async () => {
			try {
				await previous;
			} catch {
				// A failed publish must not block later aggregate updates.
			}
			try {
				await this.publish(state);
			} catch {
				// Presence failures are deliberately non-fatal to Pi.
			}
		})();
		this.presenceQueue = next;
		return next;
	}

	private async publish(state: PresenceState): Promise<void> {
		if (!this.started || this.disposed || !this.publisher) return;
		if (!(await this.isCurrentPublisher(state.publisherGeneration))) return;
		if (!(await this.ensureConnected())) return;
		if (!this.started || this.disposed || !this.publisher) return;
		const transport = this.transport;
		if (!transport || !transport.isConnected()) return;

		try {
			const didPublish = await this.stateStore.withPublisherLock(
				this.sessionId,
				state.publisherGeneration,
				async (assertOwnership) => {
					if (
						!this.started ||
						this.disposed ||
						!this.publisher ||
						this.transport !== transport ||
						!transport.isConnected() ||
						!(await this.isCurrentPublisher(state.publisherGeneration))
					) {
						return false;
					}
					await assertOwnership();
					await awaitWithTimeout(
						transport.setActivity(buildAggregateActivity(state)),
						RPC_WRITE_TIMEOUT_MS,
					);
					return true;
				},
			);
			if (didPublish) {
				this.status = "connected";
				this.retryAttempt = 0;
				this.outageWarningShown = false;
				this.clearRetryTimer();
			}
		} catch {
			await this.handleUnavailable();
		}
	}

	private async isCurrentPublisher(
		expectedGeneration = this.publisherGeneration,
	): Promise<boolean> {
		try {
			const state = await this.stateStore.read();
			return (
				state.publisherId === this.sessionId &&
				state.publisherGeneration === expectedGeneration
			);
		} catch {
			this.warnRegistryFailure();
			return false;
		}
	}

	private async ensureConnected(): Promise<boolean> {
		if (this.disposed || !this.started || !this.publisher) return false;
		if (this.transport?.isConnected()) return true;
		if (this.connectionPromise) return this.connectionPromise;

		const promise = this.openTransport();
		this.connectionPromise = promise;
		try {
			return await promise;
		} finally {
			if (this.connectionPromise === promise) this.connectionPromise = undefined;
		}
	}

	private async openTransport(): Promise<boolean> {
		if (this.disposed || !this.started || !this.publisher) return false;
		await this.closeTransport();
		let transport: DiscordPresenceTransport;
		try {
			transport = this.createTransport(this.clientId);
		} catch {
			await this.handleUnavailable();
			return false;
		}

		this.transport = transport;
		this.removeDisconnectedListener = transport.onDisconnected?.(() => {
			if (this.transport !== transport || this.disposed || !this.publisher) return;
			void this.handleUnavailable();
		});
		this.status = "connecting";
		try {
			await transport.connect();
			if (
				this.disposed ||
				!this.publisher ||
				this.transport !== transport ||
				!transport.isConnected()
			) {
				await this.closeTransport();
				return false;
			}
			return true;
		} catch {
			await this.handleUnavailable();
			return false;
		}
	}

	private async handleUnavailable(): Promise<void> {
		if (this.disposed || !this.started || !this.publisher) return;
		this.status = "reconnecting";
		if (!this.outageWarningShown) {
			this.logger(
				"[discord-presence] Discord Desktop is unavailable; retrying in the background.",
			);
			this.outageWarningShown = true;
		}
		await this.closeTransport();
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.disposed || !this.started || !this.publisher || this.retryTimer)
			return;
		const delay = Math.min(
			this.retryCapMs,
			this.retryBaseMs * 2 ** this.retryAttempt,
		);
		this.retryAttempt = Math.min(this.retryAttempt + 1, 30);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.refresh();
		}, delay);
		this.retryTimer.unref?.();
	}

	private clearRetryTimer(): void {
		if (!this.retryTimer) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	private async closeTransport(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		const removeDisconnectedListener = this.removeDisconnectedListener;
		this.removeDisconnectedListener = undefined;
		removeDisconnectedListener?.();
		if (!transport) return;
		try {
			await transport.close();
		} catch {
			// Cleanup is best effort.
		}
	}

	private warnRegistryFailure(): void {
		this.status = this.publisher ? "reconnecting" : "standby";
		if (this.registryWarningShown) return;
		this.registryWarningShown = true;
		this.logger(
			"[discord-presence] Shared session registry is unavailable; retrying.",
		);
	}
}

function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function formatDiagnosticSession(record: SessionRecord, now: number): string {
	const model = formatModelLabel(record.provider, record.modelId);
	const context =
		record.context?.percent === null || record.context?.percent === undefined
			? "ctx ?"
			: `ctx ${Math.round(record.context.percent)}%`;
	const breakdown = `in ${formatTokenCount(record.usage.input)} / out ${formatTokenCount(record.usage.output)}`;
	return `${record.projectName} · ${model} · ${formatPhase(record.phase)} · ${formatTokenCount(record.usage.total)} tok (${breakdown}) · ${formatCost(record.usage)} · ${context} · ${formatDuration(now - record.startedAt)}`;
}

export default function (pi: ExtensionAPI) {
	let manager: DiscordPresenceManager | undefined;
	let disabledReason: string | undefined;
	let agentActive = false;
	let activeToolCount = 0;

	pi.registerCommand("discord-status", {
		description: "Show Discord Rich Presence and session statistics",
		handler: async (_args, ctx) => {
			const text = manager
				? await manager.getDiagnosticText()
				: `Discord presence: ${disabledReason ?? "not started"}`;
			ctx.ui.notify(
				text,
				manager?.getStatus() === "connected" ? "info" : "warning",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionStartedAt = Date.now();
		if (manager) await manager.stop();
		manager = undefined;
		disabledReason = undefined;
		agentActive = false;
		activeToolCount = 0;

		const configuredClientId = process.env[CLIENT_ID_ENV];
		const clientId = parseClientId(configuredClientId ?? DEFAULT_CLIENT_ID);
		if (!clientId) {
			disabledReason = configuredClientId
				? `disabled: ${CLIENT_ID_ENV} is invalid`
				: "disabled: the default Discord application ID is invalid";
			defaultLogger(`[discord-presence] ${disabledReason}.`);
			return;
		}

		const projectName = await resolveProjectName(ctx.cwd, async () => {
			const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
				timeout: 2_000,
			});
			return { stdout: result.stdout, code: result.code };
		});
		const initialUsage = collectUsageFromEntries(ctx.sessionManager.getBranch());
		const initialContext = normalizeContextUsage(ctx.getContextUsage());

		manager = new DiscordPresenceManager({
			clientId,
			projectName,
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			startedAt: sessionStartedAt,
			initialUsage,
			initialContext,
		});
		void manager.start();
	});

	pi.on("model_select", async (event) => {
		await manager?.setModel(event.model.provider, event.model.id);
	});

	pi.on("message_end", async (event) => {
		const delta = extractUsage(event.message);
		if (delta) await manager?.recordUsage(delta);
	});

	pi.on("session_compact", async (event) => {
		const delta = extractUsage(event.compactionEntry);
		if (delta) await manager?.recordUsage(delta);
	});

	pi.on("session_tree", async (event) => {
		const delta = extractUsage(event.summaryEntry);
		if (delta) await manager?.recordUsage(delta);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await manager?.setContextUsage(normalizeContextUsage(ctx.getContextUsage()));
	});

	pi.on("agent_start", async () => {
		agentActive = true;
		activeToolCount = 0;
		await manager?.setPhase("thinking");
	});

	pi.on("tool_execution_start", async () => {
		activeToolCount += 1;
		await manager?.setPhase("tools");
	});

	pi.on("tool_execution_end", async () => {
		activeToolCount = Math.max(0, activeToolCount - 1);
		let phase: PresencePhase = "idle";
		if (activeToolCount > 0) phase = "tools";
		else if (agentActive) phase = "thinking";
		await manager?.setPhase(phase);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		agentActive = false;
		activeToolCount = 0;
		await manager?.setPhase("idle");
		await manager?.setContextUsage(normalizeContextUsage(ctx.getContextUsage()));
	});

	pi.on("session_shutdown", async () => {
		await manager?.stop();
		manager = undefined;
	});
}
