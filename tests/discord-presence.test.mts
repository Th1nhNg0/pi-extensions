import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SetActivity } from "@xhayper/discord-rpc";
import {
	BUTTONS_ENV,
	TRANSPORT_ENV,
	DEFAULT_CLIENT_ID,
	DEFAULT_LARGE_IMAGE_KEY,
	ACTION_BADGE_COLORS,
	ACTION_BADGE_URLS,
	DiscordPresenceManager,
	FilePresenceStateStore,
	LARGE_IMAGE_ENV,
	PRIVACY_ENV,
	PRIVACY_MODES,
	SMALL_IMAGES_ENV,
	type DiscordPresencePrefs,
	type DiscordPresenceTransport,
	type PresenceAction,
	type PresenceState,
	type PresenceStateStore,
	type SessionRecord,
	basenameForAnyPlatform,
	buildActivity,
	buildAggregateActivity,
	buildMultiSessionActivity,
	buildSingleSessionActivity,
	classifyToolAction,
	collectUsageFromEntries,
	emptyUsageTotals,
	extractUsage,
	formatAction,
	formatCost,
	formatDiscordModelLabel,
	formatModelLabel,
	formatMultiSessionDetails,
	formatMultiSessionState,
	formatPhase,
	formatPublicMetrics,
	formatSingleSessionDetails,
	formatSingleSessionState,
	formatTokenCount,
	mergeUsageTotals,
	normalizeContextUsage,
	parseClientId,
	isWslEnvironment,
	parsePrivacyMode,
	pickHighestPriorityAction,
	readPrefs,
	resolveProjectName,
	resolveDiscordTransportMode,
	summarizeModels,
	writePrefs,
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
		operation: (assertOwnership: () => Promise<void>) => Promise<T>,
	): Promise<T | undefined> {
		if (
			this.state.publisherId !== sessionId ||
			this.state.publisherGeneration !== publisherGeneration
		) {
			return undefined;
		}
		return operation(async () => undefined);
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

class BlockingTransport extends MockTransport {
	private readonly releasePromise: Promise<void>;
	private releaseFirst!: () => void;
	private markStarted!: () => void;
	readonly firstActivityStarted: Promise<void>;

	constructor() {
		super();
		this.releasePromise = new Promise((resolve) => {
			this.releaseFirst = resolve;
		});
		this.firstActivityStarted = new Promise((resolve) => {
			this.markStarted = resolve;
		});
	}

	release(): void {
		this.releaseFirst();
	}

	async setActivity(activity: SetActivity): Promise<void> {
		this.activities.push(activity);
		if (this.activities.length === 1) {
			this.markStarted();
			await this.releasePromise;
		}
	}
}

function makeRecord(
	sessionId: string,
	startedAt: number,
	overrides: Partial<SessionRecord> = {},
): SessionRecord {
	const phase = overrides.phase ?? "idle";
	const action = overrides.action ?? (phase === "tools" ? "tools" : phase);
	return {
		sessionId,
		projectName: sessionId,
		phase,
		action,
		startedAt,
		lastSeenAt: startedAt,
		usage: emptyUsageTotals(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Context & Usage Extraction Tests
// ---------------------------------------------------------------------------

test("context usage normalization clamps unsafe percentages", () => {
	assert.deepEqual(
		normalizeContextUsage({ tokens: 120, contextWindow: 1000, percent: 150 }),
		{ tokens: 120, contextWindow: 1000, percent: 100 },
	);
	assert.deepEqual(
		normalizeContextUsage({ tokens: 120, contextWindow: 1000, percent: -5 }),
		{ tokens: 120, contextWindow: 1000, percent: 0 },
	);
	assert.equal(normalizeContextUsage([]), undefined);
	assert.equal(normalizeContextUsage(null), undefined);
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

// ---------------------------------------------------------------------------
// Tool Classification Tests
// ---------------------------------------------------------------------------

test("classifyToolAction maps tool names safely and sanitizes categories", () => {
	// Reading tools
	assert.equal(classifyToolAction("read"), "reading");
	assert.equal(classifyToolAction("read_symbol"), "reading");
	assert.equal(classifyToolAction("read_enclosing"), "reading");
	assert.equal(classifyToolAction("cat"), "reading");
	assert.equal(classifyToolAction("view"), "reading");
	assert.equal(classifyToolAction("fetch_content"), "reading");

	// Searching tools
	assert.equal(classifyToolAction("grep"), "searching");
	assert.equal(classifyToolAction("ffgrep"), "searching");
	assert.equal(classifyToolAction("find"), "searching");
	assert.equal(classifyToolAction("fffind"), "searching");
	assert.equal(classifyToolAction("symbol_search"), "searching");
	assert.equal(classifyToolAction("web_search"), "searching");
	assert.equal(classifyToolAction("source_check"), "searching");
	assert.equal(classifyToolAction("ast_grep_search"), "searching");
	assert.equal(classifyToolAction("ripgrep"), "searching");
	assert.equal(classifyToolAction("rg"), "searching");

	// Editing tools
	assert.equal(classifyToolAction("edit"), "editing");
	assert.equal(classifyToolAction("write"), "editing");
	assert.equal(classifyToolAction("patch"), "editing");
	assert.equal(classifyToolAction("ast_grep_replace"), "editing");

	// Browsing tools
	assert.equal(classifyToolAction("browser"), "browsing");
	assert.equal(classifyToolAction("playwright"), "browsing");
	assert.equal(classifyToolAction("puppeteer"), "browsing");
	assert.equal(classifyToolAction("web"), "browsing");
	assert.equal(classifyToolAction("browse_docs"), "browsing");

	// Testing tools
	assert.equal(classifyToolAction("test"), "testing");
	assert.equal(classifyToolAction("pytest"), "testing");
	assert.equal(classifyToolAction("jest"), "testing");
	assert.equal(classifyToolAction("vitest"), "testing");
	assert.equal(classifyToolAction("run_tests"), "testing");

	// Running tools
	assert.equal(classifyToolAction("bash"), "running");
	assert.equal(classifyToolAction("shell"), "running");
	assert.equal(classifyToolAction("exec"), "running");
	assert.equal(classifyToolAction("powershell"), "running");
	assert.equal(classifyToolAction("cmd"), "running");
	assert.equal(classifyToolAction("terminal"), "running");

	// Unknown / fallback tools
	assert.equal(classifyToolAction("unknown_tool"), "tools");
	assert.equal(classifyToolAction(undefined), "tools");
	assert.equal(classifyToolAction(""), "tools");
});

test("pickHighestPriorityAction chooses deterministic display priority", () => {
	const actions: PresenceAction[] = ["reading", "testing", "running"];
	assert.equal(pickHighestPriorityAction(actions), "testing");

	assert.equal(
		pickHighestPriorityAction(["running", "browsing", "searching"]),
		"browsing",
	);
	assert.equal(pickHighestPriorityAction(["reading", "editing"]), "editing");
	assert.equal(pickHighestPriorityAction(["running", "reading"]), "reading");
	assert.equal(pickHighestPriorityAction([]), "tools");
});

// ---------------------------------------------------------------------------
// Model Normalization Tests
// ---------------------------------------------------------------------------

test("formatDiscordModelLabel normalizes popular and custom model names", () => {
	// OpenAI models
	assert.equal(formatDiscordModelLabel("openai", "gpt-5.6"), "GPT-5.6");
	assert.equal(formatDiscordModelLabel("openai", "gpt-5"), "GPT-5");
	assert.equal(formatDiscordModelLabel("openai", "gpt-4o"), "GPT-4o");
	assert.equal(formatDiscordModelLabel("openai", "gpt-4o-mini"), "GPT-4o mini");
	assert.equal(formatDiscordModelLabel("openai", "o1"), "o1");
	assert.equal(formatDiscordModelLabel("openai", "o3-mini"), "o3-mini");
	assert.equal(formatDiscordModelLabel("openai", "o4-mini"), "o4-mini");

	// Anthropic Claude models
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-opus-4-1"),
		"Claude Opus 4.1",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet"),
		"Claude 3.7 Sonnet",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-sonnet-4"),
		"Claude Sonnet 4",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-5-haiku"),
		"Claude 3.5 Haiku",
	);

	// Google Gemini models
	assert.equal(
		formatDiscordModelLabel("google", "gemini-3.7-pro"),
		"Gemini 3.7 Pro",
	);
	assert.equal(
		formatDiscordModelLabel("google", "gemini-2.5-flash"),
		"Gemini 2.5 Flash",
	);

	// Other known architectures
	assert.equal(formatDiscordModelLabel("zhipu", "glm-5"), "GLM-5");
	assert.equal(
		formatDiscordModelLabel("deepseek", "deepseek-r1"),
		"DeepSeek R1",
	);
	assert.equal(
		formatDiscordModelLabel("deepseek", "deepseek-v3"),
		"DeepSeek V3",
	);
	assert.equal(
		formatDiscordModelLabel("qwen", "qwen-2.5-coder"),
		"Qwen 2.5 Coder",
	);
	assert.equal(
		formatDiscordModelLabel("meta", "llama-3.3-70b"),
		"Llama 3.3 70B",
	);
	assert.equal(
		formatDiscordModelLabel("mistral", "mistral-large"),
		"Mistral Large",
	);
	assert.equal(formatDiscordModelLabel("mistral", "codestral"), "Codestral");
	assert.equal(formatDiscordModelLabel("moonshot", "kimi-k2.5"), "Kimi K2.5");

	// Strips provider prefix from modelId if present
	assert.equal(formatDiscordModelLabel("openai", "openai/gpt-5"), "GPT-5");
	assert.equal(
		formatDiscordModelLabel("anthropic", "anthropic/claude-3-7-sonnet"),
		"Claude 3.7 Sonnet",
	);

	// Unknown model fallback
	assert.equal(
		formatDiscordModelLabel("custom", "my-custom-assistant"),
		"My Custom Assistant",
	);

	// Provider-only fallback
	assert.equal(formatDiscordModelLabel("openai-codex"), "OpenAI Codex");
	assert.equal(formatDiscordModelLabel("anthropic"), "Anthropic");
	assert.equal(formatDiscordModelLabel(), "Pi");

	// Raw diagnostic label
	assert.equal(
		formatModelLabel("anthropic", "claude-3-7-sonnet"),
		"anthropic/claude-3-7-sonnet",
	);
	assert.equal(formatModelLabel(undefined, "gpt-5"), "gpt-5");
	assert.equal(formatModelLabel(), "Pi");
});

// ---------------------------------------------------------------------------
// Privacy Mode & Metrics Formatting Tests
// ---------------------------------------------------------------------------

test("parsePrivacyMode validates input and defaults to strict", () => {
	assert.equal(parsePrivacyMode("strict"), "strict");
	assert.equal(parsePrivacyMode("project"), "project");
	assert.equal(parsePrivacyMode("developer"), "developer");
	assert.equal(parsePrivacyMode("STRICT"), "strict");
	assert.equal(parsePrivacyMode("Project"), "project");
	assert.equal(parsePrivacyMode("invalid-mode"), "strict");
	assert.equal(parsePrivacyMode(undefined), "strict");
	assert.deepEqual(PRIVACY_MODES, ["strict", "project", "developer"]);
	assert.equal(PRIVACY_ENV, "PI_DISCORD_PRIVACY");
});

test("formatPublicMetrics formats tokens, context percentage, and cost by default", () => {
	const usage = {
		...emptyUsageTotals(),
		total: 42_000,
		cost: 0.84,
		costComplete: true,
	};
	const context = { tokens: 5000, contextWindow: 128_000, percent: 38.2 };

	// Shows price by default in strict mode
	assert.equal(
		formatPublicMetrics(usage, context, "strict"),
		"42k tok · ctx 38% · $0.84",
	);

	// Shows price by default in project mode
	assert.equal(
		formatPublicMetrics(usage, context, "project"),
		"42k tok · ctx 38% · $0.84",
	);

	// Developer mode: includes cost
	assert.equal(
		formatPublicMetrics(usage, context, "developer"),
		"42k tok · ctx 38% · $0.84",
	);

	// Incomplete cost prefix ~$
	const incompleteUsage = { ...usage, costComplete: false };
	assert.equal(
		formatPublicMetrics(incompleteUsage, context, "developer"),
		"42k tok · ctx 38% · ~$0.84",
	);

	// When cost is disabled explicitly (showCost = false)
	assert.equal(
		formatPublicMetrics(usage, context, "strict", false),
		"42k tok · ctx 38%",
	);

	// Without context percent: context is omitted cleanly, never ctx ?
	assert.equal(
		formatPublicMetrics(
			usage,
			{ tokens: null, contextWindow: 8000, percent: null },
			"strict",
		),
		"42k tok · $0.84",
	);

	// When usage cost is undefined: price is omitted cleanly
	const noCostUsage = { ...emptyUsageTotals(), total: 42_000 };
	assert.equal(
		formatPublicMetrics(noCostUsage, context, "strict"),
		"42k tok · ctx 38%",
	);
});

// ---------------------------------------------------------------------------
// Single-Session Presence Layout Tests
// ---------------------------------------------------------------------------

test("single session activity formatting across privacy modes and actions", () => {
	const record: SessionRecord = {
		sessionId: "s1",
		projectName: "spring2026",
		provider: "openai-codex",
		modelId: "gpt-5.6",
		phase: "thinking",
		action: "thinking",
		startedAt: 1_700_000_000_000,
		lastSeenAt: 1_700_000_000_000,
		usage: {
			...emptyUsageTotals(),
			total: 42_000,
			cost: 0.84,
			costComplete: true,
		},
		context: { tokens: 5000, contextWindow: 128_000, percent: 38 },
	};

	// Strict mode (default, shows cost by default, hides project name)
	const strictActivity = buildSingleSessionActivity(record, {
		privacyMode: "strict",
		clientId: DEFAULT_CLIENT_ID,
	});
	assert.equal(strictActivity.details, "Thinking · GPT-5.6");
	assert.equal(strictActivity.state, "42k tok · ctx 38% · $0.84");
	assert.equal(strictActivity.largeImageKey, DEFAULT_LARGE_IMAGE_KEY);
	assert.equal(strictActivity.largeImageText, "Pi Coding Agent");
	assert.equal(strictActivity.smallImageKey, ACTION_BADGE_URLS.thinking);
	assert.equal(strictActivity.smallImageText, "Thinking");
	assert.equal(strictActivity.buttons?.length, 2);

	// Project mode (shows project basename and cost)
	const projectActivity = buildSingleSessionActivity(record, {
		privacyMode: "project",
		clientId: DEFAULT_CLIENT_ID,
	});
	assert.equal(projectActivity.details, "Thinking · GPT-5.6");
	assert.equal(projectActivity.state, "spring2026 · 42k tok · ctx 38% · $0.84");

	// Tool execution actions
	const testRecord: SessionRecord = {
		...record,
		phase: "tools",
		action: "testing",
		usage: { ...record.usage, total: 47_000 },
		context: { tokens: 6000, contextWindow: 128_000, percent: 41 },
	};
	const testActivity = buildSingleSessionActivity(testRecord, {
		privacyMode: "project",
	});
	assert.equal(testActivity.details, "Running tests · GPT-5.6");
	assert.equal(testActivity.state, "spring2026 · 47k tok · ctx 41% · $0.84");
	assert.equal(testActivity.smallImageKey, ACTION_BADGE_URLS.testing);
	assert.equal(testActivity.smallImageText, "Running tests");

	// Idle state
	const idleRecord: SessionRecord = {
		...record,
		phase: "idle",
		action: "idle",
		usage: { ...record.usage, total: 52_000 },
		context: { tokens: 7000, contextWindow: 128_000, percent: 44 },
	};
	const idleActivity = buildSingleSessionActivity(idleRecord, {
		privacyMode: "project",
	});
	assert.equal(idleActivity.details, "Idle · GPT-5.6");
	assert.equal(idleActivity.state, "spring2026 · 52k tok · ctx 44% · $0.84");
	assert.equal(idleActivity.smallImageKey, ACTION_BADGE_URLS.idle);
	assert.equal(idleActivity.smallImageText, "Idle");
});

// ---------------------------------------------------------------------------
// Multi-Session Presence Layout Tests
// ---------------------------------------------------------------------------

test("multi-session activity summarizes workload, models, and projects", () => {
	const state: PresenceState = {
		version: 1,
		publisherId: "s1",
		publisherGeneration: 1,
		updatedAt: 100,
		sessions: {
			s1: makeRecord("s1", 100, {
				projectName: "project-alpha",
				provider: "openai",
				modelId: "gpt-5.6",
				phase: "thinking",
				action: "thinking",
				usage: {
					...emptyUsageTotals(),
					total: 40_000,
					cost: 0.6,
					costComplete: true,
				},
			}),
			s2: makeRecord("s2", 200, {
				projectName: "project-beta",
				provider: "openai",
				modelId: "gpt-5.6",
				phase: "tools",
				action: "testing",
				usage: {
					...emptyUsageTotals(),
					total: 30_000,
					cost: 0.4,
					costComplete: true,
				},
			}),
			s3: makeRecord("s3", 300, {
				projectName: "project-gamma",
				provider: "openai",
				modelId: "gpt-5.6",
				phase: "idle",
				action: "idle",
				usage: {
					...emptyUsageTotals(),
					total: 12_000,
					cost: 0.24,
					costComplete: true,
				},
			}),
		},
	};

	// Same model across sessions
	const activity = buildMultiSessionActivity(state);
	assert.equal(activity.details, "3 Pi sessions · 82k tok · $1.24");
	assert.equal(activity.state, "2 active · GPT-5.6 · 3 projects");

	// Mixed models
	state.sessions.s2.modelId = "claude-3-7-sonnet";
	state.sessions.s2.provider = "anthropic";
	const mixedModelActivity = buildMultiSessionActivity(state);
	assert.equal(mixedModelActivity.details, "3 Pi sessions · 82k tok · $1.24");
	assert.equal(
		mixedModelActivity.state,
		"2 active · multiple models · 3 projects",
	);

	// All sessions idle
	state.sessions.s1.phase = "idle";
	state.sessions.s2.phase = "idle";
	const allIdleActivity = buildMultiSessionActivity(state);
	assert.equal(allIdleActivity.state, "3 idle · multiple models · 3 projects");

	// Unknown / missing cost in multi-session omits cost cleanly without 'cost n/a'
	state.sessions.s1.usage.cost = undefined;
	state.sessions.s2.usage.cost = undefined;
	state.sessions.s3.usage.cost = undefined;
	const noCostActivity = buildMultiSessionActivity(state);
	assert.equal(noCostActivity.details, "3 Pi sessions · 82k tok");
});

test("buildAggregateActivity adapts between single-session and multi-session", () => {
	// Single session adaptive
	const singleState: PresenceState = {
		version: 1,
		publisherId: "s1",
		publisherGeneration: 1,
		updatedAt: 100,
		sessions: {
			s1: makeRecord("s1", 100, {
				projectName: "my-app",
				provider: "anthropic",
				modelId: "claude-3-7-sonnet",
				phase: "thinking",
				usage: { ...emptyUsageTotals(), total: 10_000 },
			}),
		},
	};
	const singleAct = buildAggregateActivity(singleState);
	assert.equal(singleAct.details, "Thinking · Claude 3.7 Sonnet");
	assert.equal(singleAct.state, "10k tok");

	// Multiple sessions
	const multiState: PresenceState = {
		...singleState,
		sessions: {
			...singleState.sessions,
			s2: makeRecord("s2", 200, {
				projectName: "other-app",
				phase: "idle",
			}),
		},
	};
	const multiAct = buildAggregateActivity(multiState);
	assert.equal(multiAct.details, "2 Pi sessions · 10k tok");
	assert.equal(multiAct.state, "1 active · multiple models · 2 projects");
});

test("buildActivity formats snapshot into v2 presence", () => {
	const activity = buildActivity({
		projectName: "pi-extensions",
		provider: "openai-codex",
		modelId: "gpt-5",
		phase: "thinking",
		startedAt: 1_700_000_000_000,
	});
	assert.equal(activity.details, "Thinking · GPT-5");
	assert.equal(activity.state, "0 tok");
	assert.equal(activity.instance, true);
	assert.equal(activity.largeImageKey, DEFAULT_LARGE_IMAGE_KEY);
	assert.equal(activity.smallImageKey, ACTION_BADGE_URLS.thinking);
});

test("presence text strips control characters before publishing", () => {
	const activity = buildActivity({
		projectName: "project\nname",
		provider: "provider\tname",
		modelId: "model\rname",
		phase: "idle",
		startedAt: 1_700_000_000_000,
	});
	assert.doesNotMatch(activity.details, /[\u0000-\u001f\u007f]/);
	assert.doesNotMatch(activity.state, /[\u0000-\u001f\u007f]/);
});

test("presence activity respects 128 character limit", () => {
	const longProject = "a".repeat(200);
	const longModel = "b".repeat(200);
	const activity = buildActivity(
		{
			projectName: longProject,
			provider: "provider",
			modelId: longModel,
			phase: "thinking",
			startedAt: 1_700_000_000_000,
		},
		{ privacyMode: "project" },
	);
	assert.ok(activity.details.length <= 128);
	assert.ok(activity.state.length <= 128);
});

// ---------------------------------------------------------------------------
// Assets & Buttons Configuration Tests
// ---------------------------------------------------------------------------

test("default action badges use Phosphor Duotone icons and distinct colors", () => {
	const expectedIcons: Record<PresenceAction, string> = {
		thinking: "brain",
		testing: "test-tube",
		editing: "pencil-simple",
		searching: "magnifying-glass",
		reading: "book-open",
		running: "terminal-window",
		browsing: "globe",
		tools: "wrench",
		idle: "pause-circle",
	};

	assert.equal(
		new Set(Object.values(ACTION_BADGE_COLORS)).size,
		Object.keys(expectedIcons).length,
	);

	for (const [action, icon] of Object.entries(expectedIcons) as Array<
		[PresenceAction, string]
	>) {
		const badgeUrl = new URL(ACTION_BADGE_URLS[action]);
		assert.equal(badgeUrl.origin, "https://wsrv.nl");
		assert.equal(badgeUrl.searchParams.get("output"), "png");
		assert.equal(badgeUrl.searchParams.get("w"), "72");
		assert.equal(badgeUrl.searchParams.get("h"), "72");

		const sourceUrl = badgeUrl.searchParams.get("url") ?? "";
		assert.match(
			sourceUrl,
			new RegExp(
				`/ph/${icon}-duotone\\.svg\\?color=%23${ACTION_BADGE_COLORS[action].slice(1)}&width=72&height=72$`,
			),
		);
	}
});

test("custom client id omits assets by default to prevent missing asset errors", () => {
	const record = makeRecord("s1", 100);
	const activity = buildSingleSessionActivity(record, {
		clientId: "999999999999999999",
	});
	assert.equal(activity.largeImageKey, undefined);
	assert.equal(activity.smallImageKey, undefined);
	// Buttons remain enabled
	assert.equal(activity.buttons?.length, 2);
});

test("environment variable overrides for buttons and assets", () => {
	const record = makeRecord("s1", 100);

	// Disable buttons via options
	const noButtons = buildSingleSessionActivity(record, {
		enableButtons: false,
	});
	assert.equal(noButtons.buttons, undefined);

	// Disable assets via options
	const noAssets = buildSingleSessionActivity(record, {
		enableAssets: false,
	});
	assert.equal(noAssets.largeImageKey, undefined);
	assert.equal(noAssets.smallImageKey, undefined);

	// Disable buttons via process.env
	process.env[BUTTONS_ENV] = "off";
	try {
		const envNoButtons = buildSingleSessionActivity(record);
		assert.equal(envNoButtons.buttons, undefined);
	} finally {
		delete process.env[BUTTONS_ENV];
	}

	// Disable large image via process.env
	process.env[LARGE_IMAGE_ENV] = "off";
	try {
		const envNoLarge = buildSingleSessionActivity(record);
		assert.equal(envNoLarge.largeImageKey, undefined);
	} finally {
		delete process.env[LARGE_IMAGE_ENV];
	}

	// Disable small images via process.env
	process.env[SMALL_IMAGES_ENV] = "off";
	try {
		const envNoSmall = buildSingleSessionActivity(record);
		assert.equal(envNoSmall.largeImageKey, DEFAULT_LARGE_IMAGE_KEY);
		assert.equal(envNoSmall.smallImageKey, undefined);
	} finally {
		delete process.env[SMALL_IMAGES_ENV];
	}

	// Custom small image key string via process.env
	process.env[SMALL_IMAGES_ENV] = "custom_badge";
	try {
		const customBadge = buildSingleSessionActivity(record);
		assert.equal(customBadge.smallImageKey, "custom_badge");
	} finally {
		delete process.env[SMALL_IMAGES_ENV];
	}

	// Custom small image URL via process.env
	process.env[SMALL_IMAGES_ENV] = "https://example.com/icon.png";
	try {
		const customUrlBadge = buildSingleSessionActivity(record);
		assert.equal(customUrlBadge.smallImageKey, "https://example.com/icon.png");
		assert.equal(customUrlBadge.smallImageUrl, "https://example.com/icon.png");
	} finally {
		delete process.env[SMALL_IMAGES_ENV];
	}

	// Custom client ID with explicit large image
	process.env[LARGE_IMAGE_ENV] = "custom_logo";
	try {
		const customClientWithAsset = buildSingleSessionActivity(record, {
			clientId: "999999999999999999",
		});
		assert.equal(customClientWithAsset.largeImageKey, "custom_logo");
	} finally {
		delete process.env[LARGE_IMAGE_ENV];
	}
});

test("formatTokenCount and formatCost format compact numbers cleanly", () => {
	assert.equal(formatTokenCount(0), "0");
	assert.equal(formatTokenCount(500), "500");
	assert.equal(formatTokenCount(1_000), "1k");
	assert.equal(formatTokenCount(1_500), "1.5k");
	assert.equal(formatTokenCount(42_000), "42k");
	assert.equal(formatTokenCount(1_000_000), "1m");
	assert.equal(formatTokenCount(2_500_000), "2.5m");

	assert.equal(formatCost({ cost: undefined, costComplete: true }), "cost n/a");
	assert.equal(formatCost({ cost: 1.24, costComplete: true }), "$1.24");
	assert.equal(formatCost({ cost: 0.84, costComplete: false }), "~$0.84");
});

test("formatPhase and formatAction return human readable labels", () => {
	assert.equal(formatPhase("thinking"), "Thinking");
	assert.equal(formatPhase("tools"), "Using tools");
	assert.equal(formatPhase("idle"), "Idle");

	assert.equal(formatAction("thinking"), "Thinking");
	assert.equal(formatAction("searching"), "Searching");
	assert.equal(formatAction("reading"), "Reading");
	assert.equal(formatAction("editing"), "Editing");
	assert.equal(formatAction("running"), "Running command");
	assert.equal(formatAction("testing"), "Running tests");
	assert.equal(formatAction("browsing"), "Browsing");
	assert.equal(formatAction("tools"), "Using tools");
	assert.equal(formatAction("idle"), "Idle");
	assert.equal(formatAction(undefined, "thinking"), "Thinking");
});

test("basenameForAnyPlatform handles Windows, POSIX, and root paths", () => {
	assert.equal(basenameForAnyPlatform("/home/user/project"), "project");
	assert.equal(basenameForAnyPlatform("C:\\Users\\me\\my-repo"), "my-repo");
	assert.equal(basenameForAnyPlatform("/"), "project");
	assert.equal(basenameForAnyPlatform(""), "project");
});

test("pure formatting helpers format single and multi session components", () => {
	const record = makeRecord("s1", 100, {
		projectName: "my-project",
		provider: "openai",
		modelId: "gpt-5.6",
		phase: "thinking",
		action: "thinking",
		usage: {
			...emptyUsageTotals(),
			total: 42_000,
			cost: 0.84,
			costComplete: true,
		},
		context: { tokens: 5000, contextWindow: 128_000, percent: 38 },
	});

	assert.equal(formatSingleSessionDetails(record), "Thinking · GPT-5.6");
	assert.equal(
		formatSingleSessionState(record, "strict"),
		"42k tok · ctx 38% · $0.84",
	);
	assert.equal(
		formatSingleSessionState(record, "project"),
		"my-project · 42k tok · ctx 38% · $0.84",
	);
	assert.equal(
		formatSingleSessionState(record, "developer"),
		"my-project · 42k tok · ctx 38% · $0.84",
	);

	const records = [
		record,
		makeRecord("s2", 200, {
			projectName: "second-project",
			provider: "openai",
			modelId: "gpt-5.6",
			phase: "idle",
		}),
	];
	assert.equal(summarizeModels(records), "GPT-5.6");
	assert.equal(
		summarizeModels([
			record,
			makeRecord("s3", 300, {
				provider: "anthropic",
				modelId: "claude-3-7-sonnet",
			}),
		]),
		"multiple models",
	);

	const summary = {
		usage: {
			...emptyUsageTotals(),
			total: 50_000,
			cost: 1.0,
			costComplete: true,
		},
		projectCount: 2,
		startTimestamp: 100,
	};
	assert.equal(
		formatMultiSessionDetails(summary, 2),
		"2 Pi sessions · 50k tok · $1.00",
	);
	assert.equal(
		formatMultiSessionState(records, 2),
		"1 active · GPT-5.6 · 2 projects",
	);
});

test("preferences read and write persist custom settings", async () => {
	const directory = await mkdtemp(join(os.tmpdir(), "pi-presence-prefs-test-"));
	const path = join(directory, "prefs.json");
	try {
		const empty = await readPrefs(path);
		assert.deepEqual(empty, {});

		const prefs: DiscordPresencePrefs = {
			privacyMode: "project",
			enabled: true,
			showCost: true,
			buttons: false,
		};
		await writePrefs(prefs, path);

		const restored = await readPrefs(path);
		assert.deepEqual(restored, prefs);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Registry Backwards Compatibility Tests
// ---------------------------------------------------------------------------

test("registry parses records without action field seamlessly", async () => {
	const directory = await mkdtemp(join(os.tmpdir(), "pi-presence-compat-test-"));
	const path = join(directory, "state.json");
	const legacyState = {
		version: 1,
		publisherId: "legacy-session",
		publisherGeneration: 1,
		updatedAt: 1_000,
		sessions: {
			"legacy-session": {
				sessionId: "legacy-session",
				projectName: "legacy-project",
				provider: "openai",
				modelId: "gpt-4",
				phase: "tools",
				startedAt: 1_000,
				lastSeenAt: 1_000,
				usage: emptyUsageTotals(),
			},
		},
	};
	await writeFile(path, JSON.stringify(legacyState), "utf8");

	const store = new FilePresenceStateStore(path, { now: () => 1_000 });
	try {
		const readState = await store.read();
		const session = readState.sessions["legacy-session"];
		assert.ok(session);
		assert.equal(session.phase, "tools");
		assert.equal(session.action, undefined);

		// Formatting falls back to phase
		const activity = buildAggregateActivity(readState);
		assert.equal(activity.details, "Using tools · GPT-4");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// File Registry & Concurrency Tests
// ---------------------------------------------------------------------------

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
		await writeFile(join(lockPath, "owner"), `${process.pid}:stale`, "utf8");
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

test("parseClientId accepts Discord snowflakes and rejects unsafe values", () => {
	assert.equal(parseClientId(`  ${CLIENT_ID}  `), CLIENT_ID);
	assert.equal(parseClientId("not-a-client-id"), undefined);
	assert.equal(parseClientId("123"), undefined);
	assert.equal(parseClientId(undefined), undefined);
});

test("detects WSL and selects the named-pipe relay transport", () => {
	assert.equal(
		isWslEnvironment({}, "linux", "5.15.90.1-microsoft-standard-WSL2"),
		true,
	);
	assert.equal(isWslEnvironment({}, "linux", "6.8.0-generic"), false);
	assert.equal(
		isWslEnvironment({ WSL_INTEROP: "/run/WSL/123" }, "linux", "6.8.0-generic"),
		true,
	);
	assert.equal(
		resolveDiscordTransportMode({}, "linux", "5.15.90.1-microsoft-standard-WSL2"),
		"wsl-relay",
	);
	assert.equal(
		resolveDiscordTransportMode({ [TRANSPORT_ENV]: "ipc" }, "linux", "5.15.90.1-microsoft-standard-WSL2"),
		"ipc",
	);
	assert.equal(
		resolveDiscordTransportMode({ [TRANSPORT_ENV]: "wsl" }, "win32", "10.0.0"),
		"wsl-relay",
	);
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

// ---------------------------------------------------------------------------
// Manager Integration & Multi-Session Failover Tests
// ---------------------------------------------------------------------------

test("manager publishes metrics and clears the final session", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "pi-extensions",
		provider: "anthropic",
		modelId: "claude-3-7-sonnet",
		startedAt: 1_700_000_000_000,
		privacyMode: "project",
		stateStore,
		createTransport: () => transport,
		logger: () => undefined,
	});

	await manager.start();
	assert.equal(manager.getStatus(), "connected");
	assert.equal(manager.isPublisher(), true);
	assert.equal(transport.connectCount, 1);

	await manager.recordUsage({ input: 1_000, output: 200, cost: 0.42 });
	await manager.setPhase("tools", "editing");
	await manager.refresh();
	const activity = transport.activities.at(-1);
	assert.equal(activity?.details, "Editing · Claude 3.7 Sonnet");
	assert.equal(activity?.state, "pi-extensions · 1.2k tok · $0.42");

	// Test dynamic privacy mode update via manager method
	await manager.setPrivacyMode("strict");
	const strictActivity = transport.activities.at(-1);
	assert.equal(strictActivity?.state, "1.2k tok · $0.42");

	const diagnostics = await manager.getDiagnosticText();
	assert.match(diagnostics, /Sessions: 1/);
	assert.match(diagnostics, /pi-extensions/);
	assert.match(diagnostics, /Editing/);

	await manager.stop();
	assert.equal(transport.clearCount, 1);
	assert.equal(transport.closeCount, 1);
});

test("manager coalesces presence updates while Discord is busy", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new BlockingTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "pi-extensions",
		startedAt: 1_700_000_000_000,
		stateStore,
		createTransport: () => transport,
		logger: () => undefined,
	});

	const startPromise = manager.start();
	await transport.firstActivityStarted;
	await manager.setPhase("thinking");
	transport.release();
	await startPromise;

	assert.equal(transport.activities.length, 2);
	assert.match(transport.activities.at(-1)?.details ?? "", /Thinking/);
	await manager.stop();
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
