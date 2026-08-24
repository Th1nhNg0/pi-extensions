import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SetActivity } from "@xhayper/discord-rpc";
import {
	DiscordPresenceManager,
	FilePresenceStateStore,
	type DiscordPresenceTransport,
	type PresenceState,
	type PresenceStateStore,
	type SessionRecord,
	buildActivity,
	collectUsageFromEntries,
	emptyUsageTotals,
	extractUsage,
	mergeUsageTotals,
	parseClientId,
	resolveProjectName,
} from "../extensions/discord-presence.ts";

const CLIENT_ID = "123456789012345678";

function cloneState(state: PresenceState): PresenceState {
	return structuredClone(state);
}

function elect(state: PresenceState): void {
	if (state.publisherId && state.sessions[state.publisherId]) return;
	const next = Object.values(state.sessions).sort(
		(a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId),
	)[0];
	const previous = state.publisherId;
	state.publisherId = next?.sessionId;
	if (state.publisherId !== previous) state.publisherGeneration += 1;
}

class MemoryStateStore implements PresenceStateStore {
	state: PresenceState = {
		version: 1,
		publisherGeneration: 0,
		sessions: {},
		updatedAt: 0,
	};

	async upsert(record: SessionRecord): Promise<PresenceState> {
		this.state.sessions[record.sessionId] = structuredClone(record);
		elect(this.state);
		return cloneState(this.state);
	}

	async remove(sessionId: string): Promise<PresenceState> {
		delete this.state.sessions[sessionId];
		if (this.state.publisherId === sessionId) this.state.publisherId = undefined;
		elect(this.state);
		return cloneState(this.state);
	}

	async read(): Promise<PresenceState> {
		return cloneState(this.state);
	}

	async withPublisherLock<T>(
		sessionId: string,
		publisherGeneration: number,
		operation: () => Promise<T>,
	): Promise<T | undefined> {
		if (
			this.state.publisherId !== sessionId ||
			this.state.publisherGeneration !== publisherGeneration
		) {
			return undefined;
		}
		return operation();
	}
}

class MockTransport implements DiscordPresenceTransport {
	connected = false;
	connectCount = 0;
	closeCount = 0;
	clearCount = 0;
	activities: SetActivity[] = [];

	isConnected(): boolean {
		return this.connected;
	}

	async connect(): Promise<void> {
		this.connectCount += 1;
		this.connected = true;
	}

	async setActivity(activity: SetActivity): Promise<void> {
		this.activities.push(activity);
	}

	async clearActivity(): Promise<void> {
		this.clearCount += 1;
	}

	async close(): Promise<void> {
		this.closeCount += 1;
		this.connected = false;
	}
}

function makeRecord(sessionId: string, startedAt: number): SessionRecord {
	return {
		sessionId,
		projectName: sessionId,
		phase: "idle",
		startedAt,
		lastSeenAt: startedAt,
		usage: emptyUsageTotals(),
	};
}

test("buildActivity formats a privacy-safe aggregate", () => {
	assert.deepEqual(
		buildActivity({
			projectName: "pi-extensions",
			provider: "openai-codex",
			modelId: "gpt-5",
			phase: "thinking",
			startedAt: 1_700_000_000_000,
		}),
		{
			details: "1 Pi session · 0 tok · cost n/a",
			state: "1 active · pi-extensions · openai-codex/gpt-5 · Thinking",
			startTimestamp: 1_700_000_000_000,
			instance: true,
		},
	);
});

test("parseClientId accepts Discord snowflakes and rejects unsafe values", () => {
	assert.equal(parseClientId(`  ${CLIENT_ID}  `), CLIENT_ID);
	assert.equal(parseClientId("not-a-client-id"), undefined);
	assert.equal(parseClientId("123"), undefined);
	assert.equal(parseClientId(undefined), undefined);
});

test("resolveProjectName prefers the Git root and falls back to cwd", async () => {
	assert.equal(
		await resolveProjectName("/workspace/fallback", async () => ({
			stdout: "C:\\Users\\me\\pi-extensions\n",
			code: 0,
		})),
		"pi-extensions",
	);
	assert.equal(await resolveProjectName("/workspace/fallback"), "fallback");
});

test("usage extraction aggregates tokens and known costs", () => {
	const delta = extractUsage({
		usage: {
			input: 100,
			output: 50,
			cacheRead: 25,
			cacheWrite: 5,
			cost: { total: 0.42 },
		},
	});
	assert.deepEqual(delta, {
		input: 100,
		output: 50,
		cacheRead: 25,
		cacheWrite: 5,
		total: 180,
		cost: 0.42,
	});

	const totals = mergeUsageTotals(emptyUsageTotals(), delta!);
	assert.equal(totals.total, 180);
	assert.equal(totals.cost, 0.42);
	assert.equal(totals.costComplete, true);

	const withoutCost = extractUsage({ usage: { input: 10, output: 5 } });
	const incomplete = mergeUsageTotals(totals, withoutCost!);
	assert.equal(incomplete.total, 195);
	assert.equal(incomplete.costComplete, false);

	const restored = collectUsageFromEntries([
		{
			type: "message",
			message: { usage: { input: 10, output: 5, cost: { total: 0.01 } } },
		},
		{
			type: "compaction",
			usage: { input: 20, output: 10, cost: { total: 0.02 } },
		},
		{
			type: "branch_summary",
			usage: { input: 30, output: 15, cost: { total: 0.03 } },
		},
	]);
	assert.equal(restored.total, 90);
	assert.equal(restored.cost, 0.06);
});

test("file registry elects a replacement after a stale publisher", async () => {
	const directory = await mkdtemp(join(os.tmpdir(), "pi-presence-test-"));
	const path = join(directory, "state.json");
	let now = 1_000;
	const store = new FilePresenceStateStore(path, {
		now: () => now,
		staleAfterMs: 1_000,
	});
	try {
		const first = await store.upsert(makeRecord("first", now));
		assert.equal(first.publisherId, "first");
		now = 5_000;
		const second = await store.upsert(makeRecord("second", now));
		assert.deepEqual(Object.keys(second.sessions), ["second"]);
		assert.equal(second.publisherId, "second");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("file registry recovers a dead stale lock directory", async () => {
	const directory = await mkdtemp(
		join(os.tmpdir(), "pi-presence-stale-lock-test-"),
	);
	const path = join(directory, "state.json");
	const lockPath = `${path}.lock`;
	try {
		await mkdir(lockPath);
		await writeFile(join(lockPath, "owner"), "99999999:dead", "utf8");
		await utimes(lockPath, new Date(0), new Date(0));
		const store = new FilePresenceStateStore(path);
		const state = await store.upsert(makeRecord("recovered", Date.now()));
		assert.equal(state.publisherId, "recovered");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("file registry serializes concurrent session updates", async () => {
	const directory = await mkdtemp(join(os.tmpdir(), "pi-presence-lock-test-"));
	const path = join(directory, "state.json");
	const options = { staleAfterMs: 30_000 };
	const firstStore = new FilePresenceStateStore(path, options);
	const secondStore = new FilePresenceStateStore(path, options);
	try {
		await Promise.all([
			firstStore.upsert(makeRecord("first", 1_000)),
			secondStore.upsert(makeRecord("second", 2_000)),
		]);
		const state = await firstStore.read();
		assert.deepEqual(Object.keys(state.sessions).sort(), ["first", "second"]);
		assert.ok(state.publisherId === "first" || state.publisherId === "second");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("manager publishes metrics and clears the final session", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "pi-extensions",
		provider: "anthropic",
		modelId: "claude",
		startedAt: 1_700_000_000_000,
		stateStore,
		createTransport: () => transport,
		logger: () => undefined,
	});

	await manager.start();
	assert.equal(manager.getStatus(), "connected");
	assert.equal(manager.isPublisher(), true);
	assert.equal(transport.connectCount, 1);

	await manager.recordUsage({ input: 1_000, output: 200, cost: 0.42 });
	await manager.setPhase("tools");
	await manager.refresh();
	const activity = transport.activities.at(-1);
	assert.equal(activity?.details, "1 Pi session · 1.2k tok · $0.42");
	assert.match(activity?.state ?? "", /Using tools/);

	const diagnostics = await manager.getDiagnosticText();
	assert.match(diagnostics, /Sessions: 1/);
	assert.match(diagnostics, /pi-extensions/);

	await manager.stop();
	assert.equal(transport.clearCount, 1);
	assert.equal(transport.closeCount, 1);
});

test("multiple sessions share one publisher and fail over safely", async () => {
	const stateStore = new MemoryStateStore();
	const firstTransport = new MockTransport();
	const secondTransport = new MockTransport();
	const first = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "first",
		startedAt: 1_000,
		stateStore,
		createTransport: () => firstTransport,
		logger: () => undefined,
	});
	const second = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "second",
		startedAt: 2_000,
		stateStore,
		createTransport: () => secondTransport,
		logger: () => undefined,
	});

	await first.start();
	await first.setPhase("thinking");
	await second.start();
	assert.equal(first.isPublisher(), true);
	assert.equal(second.getStatus(), "standby");
	assert.equal(secondTransport.connectCount, 0);

	await first.refresh();
	assert.match(firstTransport.activities.at(-1)?.details ?? "", /2 Pi sessions/);

	await first.stop();
	assert.equal(firstTransport.clearCount, 0);
	await second.refresh();
	assert.equal(second.isPublisher(), true);
	assert.equal(second.getStatus(), "connected");
	assert.equal(secondTransport.connectCount, 1);

	await second.stop();
	assert.equal(secondTransport.clearCount, 1);
});
