/** File-backed multi-session registry and its serialized-state protocol. */
import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentFilePath } from "../shared/command-kit.ts";
import {
	asRecord,
	cloneRecord,
	finiteNonNegative,
	finiteNumber,
	isSubagentRecord,
	normalizeContextUsage,
} from "./session-state.ts";
import type {
	AssertLockOwnership,
	ContextSnapshot,
	PresenceState,
	PresenceStateStore,
	SessionRecord,
	UsageTotals,
} from "./session-state.ts";
import type { PresenceAction } from "./actions.ts";

const STALE_SESSION_MS = 30_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 15_000;
const LOCK_LEASE_REFRESH_MS = Math.max(1_000, Math.floor(LOCK_STALE_MS / 3));
const LOCK_RETRY_MS = 25;

export const DEFAULT_STATE_PATH = agentFilePath("discord-presence-state.json");

function emptyState(now = Date.now()): PresenceState {
	return {
		version: 1,
		publisherGeneration: 0,
		sessions: {},
		updatedAt: now,
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

const validActions = new Set<string>([
	"thinking",
	"searching",
	"reading",
	"editing",
	"running",
	"testing",
	"browsing",
	"tools",
	"subagents",
	"idle",
]);

function parseAction(value: unknown): PresenceAction | undefined {
	return typeof value === "string" && validActions.has(value)
		? (value as PresenceAction)
		: undefined;
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
	const activeSubagents = finiteNonNegative(record.activeSubagents);
	const isSubagent =
		typeof record.isSubagent === "boolean" ? record.isSubagent : undefined;
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
		thinkingLevel:
			typeof record.thinkingLevel === "string" ? record.thinkingLevel : undefined,
		phase,
		action: parseAction(record.action),
		startedAt: startedAt as number,
		lastSeenAt: lastSeenAt as number,
		usage,
		context: parseContext(record.context),
		...(activeSubagents !== undefined && activeSubagents > 0
			? { activeSubagents }
			: {}),
		...(isSubagent ? { isSubagent: true } : {}),
	};
}

function pruneState(
	state: PresenceState,
	now: number,
	staleAfterMs: number,
): PresenceState {
	const previousPublisherId = state.publisherId;
	for (const [sessionId, record] of Object.entries(state.sessions)) {
		if (now - record.lastSeenAt > staleAfterMs || isSubagentRecord(record)) {
			delete state.sessions[sessionId];
		}
	}
	if (
		state.publisherId &&
		(!state.sessions[state.publisherId] ||
			isSubagentRecord(state.sessions[state.publisherId]))
	) {
		state.publisherId = undefined;
	}
	if (!state.publisherId) {
		const next = Object.values(state.sessions)
			.filter((r) => !isSubagentRecord(r))
			.sort(
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
	const leaseTimer = setInterval(() => {
		void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
	}, LOCK_LEASE_REFRESH_MS);
	leaseTimer.unref?.();
	try {
		await assertOwnership();
		return await operation(assertOwnership);
	} finally {
		clearInterval(leaseTimer);
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

			return withFileLock(
				this.publisherLockPath,
				(assertPublisherLock) => persist(assertPublisherLock),
				{ ownerToken: `${process.pid}:${randomUUID()}:registry:${now}` },
			);
		});
	}
}
