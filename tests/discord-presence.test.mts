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
	isReasoningSupported,
	parsePrivacyMode,
	pickHighestPriorityAction,
	readPrefs,
	resolveProjectName,
	resolveDiscordTransportMode,
	summarizeModels,
	writePrefs,
	SubagentTracker,
	isSubagentEnvironment,
	isSubagentSession,
	isSubagentRecord,
	isActivityEqual,
	isRateLimitError,
	isRegistryLockError,
	DEFAULT_MIN_PUBLISH_INTERVAL_MS,
	RATE_LIMIT_BACKOFF_MS,
	PRESENCE_REASSERT_INTERVAL_MS,
	WslDiscordIpcTransport,
	default as discordPresenceExtension,
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
	// Subagent delegation tools
	assert.equal(classifyToolAction("subagent"), "subagents");
	assert.equal(classifyToolAction("subagents"), "subagents");
	assert.equal(classifyToolAction("run_subagent"), "subagents");

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
	assert.equal(
		formatModelLabel("anthropic", "claude-3-7-sonnet", "high"),
		"anthropic/claude-3-7-sonnet (high)",
	);
	assert.equal(
		formatModelLabel("anthropic", "claude-3-7-sonnet", "off"),
		"anthropic/claude-3-7-sonnet (off)",
	);

	// Thinking mode / level formatting
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", "high"),
		"Claude 3.7 Sonnet (high)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", "off"),
		"Claude 3.7 Sonnet (off)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", "medium"),
		"Claude 3.7 Sonnet (medium)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", "low"),
		"Claude 3.7 Sonnet (low)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", "minimal"),
		"Claude 3.7 Sonnet (minimal)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", "xhigh"),
		"Claude 3.7 Sonnet (xhigh)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", "max"),
		"Claude 3.7 Sonnet (max)",
	);
	assert.equal(
		formatDiscordModelLabel("openai", "o3-mini", "high"),
		"o3-mini (high)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet:high"),
		"Claude 3.7 Sonnet (high)",
	);
	assert.equal(
		formatDiscordModelLabel("anthropic", "claude-3-7-sonnet", undefined),
		"Claude 3.7 Sonnet",
	);
	assert.equal(
		formatDiscordModelLabel(undefined, undefined, "high"),
		"Pi (high)",
	);
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

test("isReasoningSupported identifies models with reasoning support", () => {
	assert.equal(isReasoningSupported({ reasoning: true }), true);
	assert.equal(isReasoningSupported({ reasoning: false }), false);
	assert.equal(
		isReasoningSupported({ thinkingLevelMap: { high: "high" } }),
		true,
	);
	assert.equal(isReasoningSupported({ id: "claude-3-7-sonnet" }), true);
	assert.equal(isReasoningSupported({ id: "claude-sonnet-4" }), true);
	assert.equal(isReasoningSupported({ id: "o1-preview" }), true);
	assert.equal(isReasoningSupported({ id: "o3-mini" }), true);
	assert.equal(isReasoningSupported({ id: "gemini-2.5-pro" }), true);
	assert.equal(isReasoningSupported({ id: "deepseek-r1" }), true);
	assert.equal(isReasoningSupported({ id: "gpt-4o" }), false);
	assert.equal(isReasoningSupported({ id: "gemini-2.5-flash" }), false);
	assert.equal(isReasoningSupported(undefined), false);
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
		subagents: "robot",
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
	assert.equal(formatAction("subagents"), "Running subagents");
	assert.equal(formatAction("idle", "idle", 0), "Idle");
	assert.equal(formatAction("idle", "idle", 1), "1 subagent running");
	assert.equal(formatAction("idle", "idle", 2), "2 subagents running");
	assert.equal(formatAction("thinking", "thinking", 1), "Thinking (1 subagent)");
	assert.equal(formatAction("thinking", "thinking", 2), "Thinking (2 subagents)");
	assert.equal(formatAction("editing", "tools", 3), "Editing (3 subagents)");
	assert.equal(formatAction("subagents", "tools", 2), "2 subagents running");
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
	const recordWithThinking = makeRecord("s1", 100, {
		provider: "anthropic",
		modelId: "claude-3-7-sonnet",
		thinkingLevel: "high",
		phase: "thinking",
		action: "thinking",
	});
	assert.equal(
		formatSingleSessionDetails(recordWithThinking),
		"Thinking · Claude 3.7 Sonnet (high)",
	);
	const recordWithThinkingOff = makeRecord("s1", 100, {
		provider: "anthropic",
		modelId: "claude-3-7-sonnet",
		thinkingLevel: "off",
		phase: "idle",
		action: "idle",
	});
	assert.equal(
		formatSingleSessionDetails(recordWithThinkingOff),
		"Idle · Claude 3.7 Sonnet (off)",
	);
	const recordTestingThinking = makeRecord("s1", 100, {
		provider: "anthropic",
		modelId: "claude-3-7-sonnet",
		thinkingLevel: "high",
		phase: "tools",
		action: "testing",
	});
	assert.equal(
		formatSingleSessionDetails(recordTestingThinking),
		"Running tests · Claude 3.7 Sonnet (high)",
	);
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
	const thinkingRecords = [
		makeRecord("s1", 100, {
			provider: "anthropic",
			modelId: "claude-3-7-sonnet",
			thinkingLevel: "high",
		}),
		makeRecord("s2", 200, {
			provider: "anthropic",
			modelId: "claude-3-7-sonnet",
			thinkingLevel: "high",
		}),
	];
	assert.equal(summarizeModels(thinkingRecords), "Claude 3.7 Sonnet (high)");

	const mixedThinkingRecords = [
		makeRecord("s1", 100, {
			provider: "anthropic",
			modelId: "claude-3-7-sonnet",
			thinkingLevel: "high",
		}),
		makeRecord("s2", 200, {
			provider: "anthropic",
			modelId: "claude-3-7-sonnet",
			thinkingLevel: "low",
		}),
	];
	assert.equal(summarizeModels(mixedThinkingRecords), "multiple models");

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
	assert.equal(
		formatMultiSessionState(records, 2, 3),
		"1 active (3 subagents) · GPT-5.6 · 2 projects",
	);

	const idleRecords = [
		makeRecord("s1", 100, { phase: "idle", action: "idle" }),
		makeRecord("s2", 200, { phase: "idle", action: "idle", activeSubagents: 2 }),
	];
	assert.equal(
		formatMultiSessionState(idleRecords, 2, 2),
		"1 active (2 subagents) · Pi · 2 projects",
	);

	const idleWithSubagents = makeRecord("sub-1", 100, {
		projectName: "my-project",
		provider: "anthropic",
		modelId: "claude-sonnet-4",
		phase: "idle",
		action: "idle",
		activeSubagents: 2,
	});
	assert.equal(
		formatSingleSessionDetails(idleWithSubagents),
		"2 subagents running · Claude Sonnet 4",
	);

	const activeWithSubagents = makeRecord("sub-2", 100, {
		projectName: "my-project",
		provider: "anthropic",
		modelId: "claude-sonnet-4",
		phase: "thinking",
		action: "thinking",
		activeSubagents: 1,
	});
	assert.equal(
		formatSingleSessionDetails(activeWithSubagents),
		"Thinking (1 subagent) · Claude Sonnet 4",
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
		resolveDiscordTransportMode(
			{ [TRANSPORT_ENV]: "ipc" },
			"linux",
			"5.15.90.1-microsoft-standard-WSL2",
		),
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

test("extension registers only unified 'discord' command and no redundant alias", () => {
	const registeredCommands: string[] = [];
	const dummyPi = {
		registerCommand: (name: string) => {
			registeredCommands.push(name);
		},
		on: () => {},
	};
	discordPresenceExtension(
		dummyPi as unknown as Parameters<typeof discordPresenceExtension>[0],
	);
	assert.deepEqual(registeredCommands, ["discord"]);
});

test("extension registers thinking_level_select and model_select event handlers", () => {
	const registeredEvents: string[] = [];
	const handlers: Record<string, Function> = {};
	const dummyPi = {
		registerCommand: () => {},
		on: (event: string, handler: Function) => {
			registeredEvents.push(event);
			handlers[event] = handler;
		},
	};
	discordPresenceExtension(
		dummyPi as unknown as Parameters<typeof discordPresenceExtension>[0],
	);
	assert.ok(registeredEvents.includes("thinking_level_select"));
	assert.ok(registeredEvents.includes("model_select"));
	assert.ok(typeof handlers["thinking_level_select"] === "function");
	assert.ok(typeof handlers["model_select"] === "function");
});

test("presence can restart after a completed stop", async (t) => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID, projectName: "restart", stateStore,
		createTransport: () => transport, logger: () => {},
	});
	t.after(() => manager.stop());
	await manager.start();
	await manager.stop();
	assert.equal(Object.keys(stateStore.state.sessions).length, 0);
	await manager.setPhase("thinking");
	await manager.start();
	assert.equal(manager.getStatus(), "connected");
	assert.equal(transport.connectCount, 2);
	assert.equal(Object.keys(stateStore.state.sessions).length, 1);
	assert.match(transport.activities.at(-1)?.details ?? "", /Thinking/);
});

test("heartbeat and phase updates respect reconnect backoff", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	transport.connect = async () => {
		transport.connectCount++;
		throw new Error("Discord is offline");
	};
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID, projectName: "retry", stateStore,
		createTransport: () => transport, logger: () => {},
		heartbeatMs: 1_000, retryBaseMs: 10_000, retryCapMs: 60_000,
	});
	t.after(() => manager.stop());
	await manager.start();
	assert.equal(transport.connectCount, 1);
	t.mock.timers.tick(5_000);
	await manager.setPhase("thinking");
	await manager.refresh();
	assert.equal(transport.connectCount, 1);
	t.mock.timers.tick(5_000);
	await manager.refresh();
	assert.equal(transport.connectCount, 2);
	t.mock.timers.tick(10_000);
	await manager.setPhase("tools", "editing");
	await manager.refresh();
	assert.equal(transport.connectCount, 2);
	t.mock.timers.tick(10_000);
	await manager.refresh();
	assert.equal(transport.connectCount, 3);
});

test("publisher reloads shared privacy after a standby session changes it", async (t) => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	let privacyMode: "project" | "strict" = "project";
	const first = new DiscordPresenceManager({
		clientId: CLIENT_ID, projectName: "private-project", startedAt: 1_000,
		privacyMode, readPrivacyMode: async () => privacyMode, stateStore,
		createTransport: () => transport, logger: () => {},
	});
	const second = new DiscordPresenceManager({
		clientId: CLIENT_ID, projectName: "standby", startedAt: 2_000,
		privacyMode, readPrivacyMode: async () => privacyMode, stateStore,
		createTransport: () => new MockTransport(), logger: () => {},
	});
	t.after(async () => { await second.stop(); await first.stop(); });
	await first.start();
	assert.match(transport.activities.at(-1)?.state ?? "", /private-project/);
	await second.start();
	assert.equal(second.getStatus(), "standby");
	// The command persists preferences before refreshing the invoking manager.
	privacyMode = "strict";
	await second.setPrivacyMode("strict");
	await second.stop();
	await first.refresh();
	assert.equal(first.getPrivacyMode(), "strict");
	assert.doesNotMatch(JSON.stringify(transport.activities.at(-1)), /private-project/);
});

test("buildSingleSessionActivity renders robot badge and details when subagents are running", () => {
	const idleWithSubagents = makeRecord("sub-idle", 100, {
		projectName: "pi-repo",
		provider: "anthropic",
		modelId: "claude-sonnet-4",
		phase: "idle",
		action: "idle",
		activeSubagents: 2,
	});
	const idleActivity = buildSingleSessionActivity(idleWithSubagents);
	assert.equal(idleActivity.details, "2 subagents running · Claude Sonnet 4");
	assert.equal(idleActivity.smallImageKey, ACTION_BADGE_URLS.subagents);
	assert.equal(idleActivity.smallImageText, "2 subagents running");

	const thinkingWithSubagents = makeRecord("sub-thinking", 100, {
		projectName: "pi-repo",
		provider: "anthropic",
		modelId: "claude-sonnet-4",
		phase: "thinking",
		action: "thinking",
		activeSubagents: 1,
	});
	const thinkingActivity = buildSingleSessionActivity(thinkingWithSubagents);
	assert.equal(thinkingActivity.details, "Thinking (1 subagent) · Claude Sonnet 4");
	assert.equal(thinkingActivity.smallImageKey, ACTION_BADGE_URLS.thinking);
	assert.equal(thinkingActivity.smallImageText, "Thinking (1 subagent)");
});

test("SubagentTracker tracks async lifecycle and foreground tool executions", () => {
	class MockBus {
		private listeners = new Map<string, Array<(data: unknown) => void>>();
		emitted: Array<{ event: string; data: unknown }> = [];

		on(event: string, handler: (data: unknown) => void) {
			let list = this.listeners.get(event);
			if (!list) {
				list = [];
				this.listeners.set(event, list);
			}
			list.push(handler);
			return () => {
				const idx = list?.indexOf(handler) ?? -1;
				if (idx >= 0) list?.splice(idx, 1);
			};
		}

		emit(event: string, data: unknown) {
			this.emitted.push({ event, data });
			const list = this.listeners.get(event);
			if (list) {
				for (const handler of [...list]) handler(data);
			}
		}
	}

	const bus = new MockBus();
	const counts: number[] = [];
	const tracker = new SubagentTracker({
		events: bus,
		sessionId: "sess-1",
		onCountChange: (c) => counts.push(c),
	});

	assert.equal(tracker.getTotalActiveCount(), 0);
	assert.equal(tracker.isInstalled(), false);

	// Async start for current session
	bus.emit("subagent:async-started", { id: "job-1", sessionId: "sess-1" });
	assert.equal(tracker.getTotalActiveCount(), 1);
	assert.equal(tracker.isInstalled(), true);
	assert.deepEqual(counts, [1]);

	// Another async start for current session
	bus.emit("subagent:async-started", { id: "job-2", sessionId: "sess-1" });
	assert.equal(tracker.getTotalActiveCount(), 2);
	assert.deepEqual(counts, [1, 2]);

	// Async start for different session should be ignored
	bus.emit("subagent:async-started", { id: "job-3", sessionId: "other-session" });
	assert.equal(tracker.getTotalActiveCount(), 2);
	assert.deepEqual(counts, [1, 2]);

	// Foreground tool execution for subagent
	tracker.onToolExecutionStart("tool-call-1", "subagent");
	assert.equal(tracker.getTotalActiveCount(), 3);
	assert.deepEqual(counts, [1, 2, 3]);

	// Foreground tool execution end
	tracker.onToolExecutionEnd("tool-call-1");
	assert.equal(tracker.getTotalActiveCount(), 2);
	assert.deepEqual(counts, [1, 2, 3, 2]);

	// Complete first async job
	bus.emit("subagent:async-complete", { runId: "job-1" });
	assert.equal(tracker.getTotalActiveCount(), 1);
	assert.deepEqual(counts, [1, 2, 3, 2, 1]);

	// Complete second async job
	bus.emit("subagent:async-complete", { id: "job-2" });
	assert.equal(tracker.getTotalActiveCount(), 0);
	assert.deepEqual(counts, [1, 2, 3, 2, 1, 0]);

	tracker.dispose();
});

test("SubagentTracker reconciles via RPC status request", () => {
	class MockBus {
		private listeners = new Map<string, Array<(data: unknown) => void>>();
		emitted: Array<{ event: string; data: unknown }> = [];

		on(event: string, handler: (data: unknown) => void) {
			let list = this.listeners.get(event);
			if (!list) {
				list = [];
				this.listeners.set(event, list);
			}
			list.push(handler);
			return () => {
				const idx = list?.indexOf(handler) ?? -1;
				if (idx >= 0) list?.splice(idx, 1);
			};
		}

		emit(event: string, data: unknown) {
			this.emitted.push({ event, data });
			const list = this.listeners.get(event);
			if (list) {
				for (const handler of [...list]) handler(data);
			}
		}
	}

	const bus = new MockBus();
	const counts: number[] = [];
	const tracker = new SubagentTracker({
		events: bus,
		sessionId: "sess-rpc",
		onCountChange: (c) => counts.push(c),
	});

	tracker.queryRpcStatus();
	assert.equal(bus.emitted.length, 1);
	assert.equal(bus.emitted[0].event, "subagents:rpc:v1:request");
	const req = bus.emitted[0].data as { requestId: string; method: string };
	assert.equal(req.method, "status");

	// Deliver RPC reply
	bus.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
		ok: true,
		result: { fleet: { totalActive: 4 } },
	});

	assert.equal(tracker.getTotalActiveCount(), 4);
	assert.equal(tracker.isInstalled(), true);
	assert.deepEqual(counts, [4]);

	tracker.dispose();
});

test("DiscordPresenceManager setActiveSubagents updates presence and activity", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "subagent-test",
		stateStore,
		createTransport: () => transport,
		logger: () => {},
		enableAssets: true,
	});

	await manager.start();
	assert.equal(manager.getActiveSubagents(), 0);
	assert.match(transport.activities.at(-1)?.details ?? "", /Idle/);
	assert.equal(transport.activities.at(-1)?.smallImageKey, ACTION_BADGE_URLS.idle);

	// Update subagents to 2 while session is idle
	await manager.setActiveSubagents(2);
	await manager.refresh();
	assert.equal(manager.getActiveSubagents(), 2);
	assert.match(transport.activities.at(-1)?.details ?? "", /2 subagents running/);
	assert.equal(transport.activities.at(-1)?.smallImageKey, ACTION_BADGE_URLS.subagents);
	assert.equal(transport.activities.at(-1)?.smallImageText, "2 subagents running");

	// Subagents complete -> count becomes 0
	await manager.setActiveSubagents(0);
	await manager.refresh();
	assert.equal(manager.getActiveSubagents(), 0);
	assert.match(transport.activities.at(-1)?.details ?? "", /Idle/);
	assert.equal(transport.activities.at(-1)?.smallImageKey, ACTION_BADGE_URLS.idle);
	assert.equal(transport.activities.at(-1)?.smallImageText, "Idle");
	await manager.stop();
});

test("DiscordPresenceManager setThinkingLevel and setModel updates presence details", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "thinking-test",
		provider: "anthropic",
		modelId: "claude-3-7-sonnet",
		thinkingLevel: "high",
		stateStore,
		createTransport: () => transport,
		logger: () => {},
	});

	await manager.start();
	assert.equal(
		transport.activities.at(-1)?.details,
		"Idle · Claude 3.7 Sonnet (high)",
	);

	// Change thinking level via setThinkingLevel
	await manager.setThinkingLevel("low");
	await manager.refresh();
	assert.equal(
		transport.activities.at(-1)?.details,
		"Idle · Claude 3.7 Sonnet (low)",
	);

	// Change thinking level to off
	await manager.setThinkingLevel("off");
	await manager.refresh();
	assert.equal(
		transport.activities.at(-1)?.details,
		"Idle · Claude 3.7 Sonnet (off)",
	);

	// Switch model to a model without thinking mode
	await manager.setModel("openai", "gpt-4o", undefined);
	await manager.refresh();
	assert.equal(
		transport.activities.at(-1)?.details,
		"Idle · GPT-4o",
	);

	// Switch model to a reasoning model with thinking level
	await manager.setModel("openai", "o3-mini", "medium");
	await manager.refresh();
	assert.equal(
		transport.activities.at(-1)?.details,
		"Idle · o3-mini (medium)",
	);

	await manager.stop();
});

test("FilePresenceStateStore serializes and restores activeSubagents", async () => {
	const directory = await mkdtemp(join(os.tmpdir(), "pi-presence-subagent-test-"));
	const path = join(directory, "state.json");
	const store = new FilePresenceStateStore(path);

	const record = makeRecord("session-with-subagents", 100, {
		projectName: "test-proj",
		activeSubagents: 3,
	});

	await store.upsert(record);
	const restored = await store.read();
	assert.equal(restored.sessions["session-with-subagents"]?.activeSubagents, 3);

	await rm(directory, { recursive: true, force: true });
});

test("FilePresenceStateStore serializes and restores thinkingLevel", async () => {
	const directory = await mkdtemp(
		join(os.tmpdir(), "pi-presence-thinking-test-"),
	);
	const path = join(directory, "state.json");
	const store = new FilePresenceStateStore(path);

	const record = makeRecord("session-with-thinking", 100, {
		projectName: "test-proj",
		provider: "anthropic",
		modelId: "claude-3-7-sonnet",
		thinkingLevel: "high",
	});

	await store.upsert(record);
	const restored = await store.read();
	assert.equal(
		restored.sessions["session-with-thinking"]?.thinkingLevel,
		"high",
	);

	await rm(directory, { recursive: true, force: true });
});

test("isSubagentEnvironment detects child process flags", () => {
	assert.equal(isSubagentEnvironment({ PI_SUBAGENT_CHILD: "1" }), true);
	assert.equal(isSubagentEnvironment({ PI_SUBAGENT_CHILD: "true" }), true);
	assert.equal(isSubagentEnvironment({ PI_IS_SUBAGENT: "1" }), true);
	assert.equal(isSubagentEnvironment({ PI_IS_SUBAGENT: "true" }), true);
	assert.equal(isSubagentEnvironment({ PI_SUBAGENT_CHILD: "0" }), false);
	assert.equal(isSubagentEnvironment({}), false);
});

test("isSubagentSession detects worktree and subagent paths", () => {
	assert.equal(
		isSubagentSession({ cwd: "/home/user/code/pi-worktree-123-0" }),
		true,
	);
	assert.equal(
		isSubagentSession({
			cwd: "/home/user/code/repo",
			sessionManager: {
				getSessionFile: () => "/home/user/code/repo/.pi/subagents/session-1.jsonl",
			},
		}),
		true,
	);
	assert.equal(
		isSubagentSession({
			cwd: "/home/user/code/repo",
			sessionManager: {
				getSessionFile: () => "/home/user/code/repo/session-1.jsonl",
			},
		}),
		false,
	);
});

test("isSubagentRecord identifies subagent session records", () => {
	const mainRec = makeRecord("main-1", 100, { projectName: "my-project" });
	const explicitSubRec = makeRecord("sub-1", 100, {
		projectName: "my-project",
		isSubagent: true,
	});
	const worktreeRec = makeRecord("sub-wt", 100, {
		projectName: "my-project/pi-worktree-abc-0",
	});
	assert.equal(isSubagentRecord(mainRec), false);
	assert.equal(isSubagentRecord(explicitSubRec), true);
	assert.equal(isSubagentRecord(worktreeRec), true);
});

test("subagents running are not calculated as sessions", () => {
	const mainSession = makeRecord("main-sess", 100, {
		projectName: "main-project",
		phase: "thinking",
		action: "thinking",
		activeSubagents: 2,
	});
	const subagentSession = makeRecord("sub-wt", 150, {
		projectName: "main-project/pi-worktree-123-0",
		phase: "tools",
		action: "reading",
		isSubagent: true,
	});

	const state: PresenceState = {
		version: 1,
		publisherId: "main-sess",
		publisherGeneration: 1,
		sessions: {
			"main-sess": mainSession,
			"sub-wt": subagentSession,
		},
		updatedAt: 200,
	};

	// buildAggregateActivity should treat this as a single session, not 2 sessions
	const activity = buildAggregateActivity(state);
	// Details should show subagent running info under main session, not "2 Pi sessions"
	assert.match(activity.details, /Thinking \(2 subagents\)/);
	assert.doesNotMatch(activity.details, /2 Pi sessions/);
});

test("isActivityEqual detects identical and differing activity payloads", () => {
	const a = {
		details: "Editing · Claude 3.7 Sonnet",
		state: "12k tok · $0.05",
		startTimestamp: 1000,
		instance: true as const,
		largeImageKey: "key-1",
		buttons: [{ label: "Pi", url: "https://pi.dev" }],
	};
	const b = { ...a };
	assert.equal(isActivityEqual(a, b), true);

	const diffDetails = { ...a, details: "Thinking · Claude 3.7 Sonnet" };
	assert.equal(isActivityEqual(a, diffDetails), false);

	const diffButtons = {
		...a,
		buttons: [{ label: "Pi Coding Agent", url: "https://pi.dev" }],
	};
	assert.equal(isActivityEqual(a, diffButtons), false);
});

test("DiscordPresenceManager deduplicates identical presence payloads without calling Discord RPC repeatedly", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "dedup-test",
		stateStore,
		createTransport: () => transport,
		logger: () => {},
	});

	await manager.start();
	assert.equal(transport.activities.length, 1);

	// Re-applying same state via refresh should not invoke setActivity again
	await manager.refresh();
	assert.equal(transport.activities.length, 1);

	// Phase change modifies activity, so it publishes once more
	await manager.setPhase("thinking");
	await manager.refresh();
	assert.equal(transport.activities.length, 2);

	// Refreshing again with same phase should NOT publish
	await manager.refresh();
	assert.equal(transport.activities.length, 2);

	await manager.stop();
});

test("DiscordPresenceManager handles Discord RPC rate limit error (4002) without dropping connection", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	let failWithRateLimit = false;
	const originalSetActivity = transport.setActivity.bind(transport);
	transport.setActivity = async (activity) => {
		if (failWithRateLimit) {
			const err = new Error("Rate limited");
			(err as unknown as { code: number }).code = 4002;
			throw err;
		}
		return originalSetActivity(activity);
	};

	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "rate-limit-test",
		stateStore,
		createTransport: () => transport,
		logger: () => {},
	});

	await manager.start();
	assert.equal(manager.getStatus(), "connected");

	// Next update hits 4002 rate limit
	failWithRateLimit = true;
	await manager.setPhase("thinking");
	await manager.refresh();

	// Status should remain connected, transport should NOT be closed or destroyed
	assert.equal(manager.getStatus(), "connected");
	assert.equal(transport.closeCount, 0);

	await manager.stop();
});

test("publisher coalesces rapid updates into one Discord update per Rich Presence window", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "cadence",
		stateStore,
		createTransport: () => transport,
		minPublishIntervalMs: DEFAULT_MIN_PUBLISH_INTERVAL_MS,
		now: () => Date.now(),
		logger: () => {},
	});

	await manager.start();
	assert.equal(transport.activities.length, 1);

	// A burst of phase changes inside one window must not reach Discord again.
	for (let i = 0; i < 8; i += 1) {
		await manager.setPhase("thinking");
		await manager.setPhase("tools", "editing");
	}
	assert.equal(transport.activities.length, 1);

	// After the window elapses only the newest state is published once.
	t.mock.timers.tick(DEFAULT_MIN_PUBLISH_INTERVAL_MS);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.activities.length, 2);
	assert.match(transport.activities.at(-1)?.details ?? "", /Editing/);

	await manager.stop();
});

test("publisher re-asserts unchanged presence after the reassert interval", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "reassert",
		stateStore,
		createTransport: () => transport,
		heartbeatMs: 5_000,
		minPublishIntervalMs: DEFAULT_MIN_PUBLISH_INTERVAL_MS,
		now: () => Date.now(),
		logger: () => {},
	});

	await manager.start();
	assert.equal(transport.activities.length, 1);

	// Heartbeats inside the reassert interval must not republish.
	t.mock.timers.tick(PRESENCE_REASSERT_INTERVAL_MS / 2);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.activities.length, 1);

	// After the reassert interval the unchanged activity is re-sent once.
	t.mock.timers.tick(PRESENCE_REASSERT_INTERVAL_MS / 2);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.activities.length, 2);

	await manager.stop();
});

test("rate limit backoff suppresses republishes and escalates on repeat limits", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	let rateLimited = false;
	const originalSetActivity = transport.setActivity.bind(transport);
	transport.setActivity = async (activity) => {
		if (rateLimited) {
			const err = new Error("rate limited");
			(err as unknown as { code: number }).code = 4002;
			throw err;
		}
		return originalSetActivity(activity);
	};
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "rate-limit-backoff",
		stateStore,
		createTransport: () => transport,
		now: () => Date.now(),
		logger: () => {},
	});

	await manager.start();
	assert.equal(transport.activities.length, 1);

	rateLimited = true;
	await manager.setPhase("thinking");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(manager.getStatus(), "connected");
	assert.equal(transport.activities.length, 1);

	// The pending update waits for the backoff instead of republishing immediately.
	await manager.setPhase("tools", "editing");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.activities.length, 1);

	// A second consecutive rate limit doubles the backoff to 30s.
	t.mock.timers.tick(RATE_LIMIT_BACKOFF_MS);
	await new Promise((resolve) => setImmediate(resolve));
	rateLimited = false;
	t.mock.timers.tick(RATE_LIMIT_BACKOFF_MS * 2 - 1);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.activities.length, 1);
	t.mock.timers.tick(1);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.activities.length, 2);

	await manager.stop();
});

test("extension does not register when running inside a subagent process", () => {
	const registeredCommands: string[] = [];
	const eventsRegistered: string[] = [];
	const dummyPi = {
		registerCommand: (name: string) => {
			registeredCommands.push(name);
		},
		on: (event: string) => {
			eventsRegistered.push(event);
		},
	};

	const originalEnv = process.env.PI_SUBAGENT_CHILD;
	try {
		process.env.PI_SUBAGENT_CHILD = "1";
		discordPresenceExtension(
			dummyPi as unknown as Parameters<typeof discordPresenceExtension>[0],
		);
		assert.equal(registeredCommands.length, 0);
		assert.equal(eventsRegistered.length, 0);
	} finally {
		if (originalEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = originalEnv;
	}
});

test("registry lock timeout does not disconnect or destroy Discord transport", async () => {
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "lock-test",
		stateStore,
		createTransport: () => transport,
		logger: () => {},
	});

	await manager.start();
	assert.equal(manager.getStatus(), "connected");
	assert.equal(transport.connectCount, 1);

	// Simulate withPublisherLock failing with lock timeout
	const origWithPublisherLock = stateStore.withPublisherLock.bind(stateStore);
	stateStore.withPublisherLock = async () => {
		throw new Error("presence state lock timeout");
	};

	await manager.setPhase("thinking");
	await manager.refresh();

	// Transport should NOT have been closed
	assert.equal(transport.closeCount, 0);

	// Restore and stop
	stateStore.withPublisherLock = origWithPublisherLock;
	await manager.stop();
	assert.equal(transport.closeCount, 1);
});
test("isRegistryLockError detects lock and state file errors", () => {
	assert.equal(isRegistryLockError(new Error("presence state lock timeout")), true);
	assert.equal(isRegistryLockError(new Error("presence lock ownership lost")), true);
	assert.equal(isRegistryLockError(new Error("corrupted state file")), true);
	assert.equal(isRegistryLockError(new Error("Discord is offline")), false);
	assert.equal(isRegistryLockError(null), false);
});

test("WslDiscordIpcTransport efficiently reassembles fragmented incoming data and frees buffers", async () => {
	const transport = new WslDiscordIpcTransport({ client: { clientId: CLIENT_ID } as unknown as import("@xhayper/discord-rpc").Client });
	const messages: unknown[] = [];
	transport.on("message", (msg) => messages.push(msg));

	const payload = Buffer.from(JSON.stringify({ cmd: "DISPATCH", evt: "READY", data: { user: { id: "123" } } }));
	const packet = Buffer.alloc(8 + payload.length);
	packet.writeUInt32LE(1, 0);
	packet.writeUInt32LE(payload.length, 4);
	payload.copy(packet, 8);

	// Split across 1-byte, 7-byte (header split) and multiple body chunks
	const chunk1 = packet.subarray(0, 1);
	const chunk2 = packet.subarray(1, 8);
	const chunk3 = packet.subarray(8, 20);
	const chunk4 = packet.subarray(20);

	// Feed chunks
	(transport as unknown as { handleIncomingData: (b: Buffer) => void }).handleIncomingData(chunk1);
	assert.equal(messages.length, 0);
	(transport as unknown as { handleIncomingData: (b: Buffer) => void }).handleIncomingData(chunk2);
	assert.equal(messages.length, 0);
	(transport as unknown as { handleIncomingData: (b: Buffer) => void }).handleIncomingData(chunk3);
	assert.equal(messages.length, 0);
	(transport as unknown as { handleIncomingData: (b: Buffer) => void }).handleIncomingData(chunk4);

	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0], { cmd: "DISPATCH", evt: "READY", data: { user: { id: "123" } } });
	// Ensure buffer memory is reclaimed
	assert.equal(transport.incoming.length, 0);
	await transport.close();
});

test("SubagentTracker disposal cleans up in-flight RPC reply listeners and timers", () => {
	class TrackedMockBus {
		listeners = new Map<string, (data: unknown) => void>();
		on(event: string, handler: (data: unknown) => void) {
			this.listeners.set(event, handler);
			return () => this.listeners.delete(event);
		}
		emit(_event: string, _data: unknown) {}
	}
	const bus = new TrackedMockBus();
	let notifiedCount = -1;
	const tracker = new SubagentTracker({
		events: bus,
		sessionId: "clean-test",
		onCountChange: (c) => { notifiedCount = c; },
	});

	tracker.queryRpcStatus();
	// 3 persistent listeners (started, complete, ready) + 1 request listener = 4
	assert.equal(bus.listeners.size, 4);

	tracker.dispose();
	// All listeners removed!
	assert.equal(bus.listeners.size, 0);
	assert.equal(notifiedCount, -1);
});

test("SubagentTracker cancels previous in-flight RPC query on rapid subsequent queries", () => {
	class TrackedMockBus {
		listeners = new Map<string, (data: unknown) => void>();
		on(event: string, handler: (data: unknown) => void) {
			this.listeners.set(event, handler);
			return () => this.listeners.delete(event);
		}
		emit(_event: string, _data: unknown) {}
	}
	const bus = new TrackedMockBus();
	const tracker = new SubagentTracker({
		events: bus,
		sessionId: "rapid-rpc",
	});

	for (let i = 0; i < 20; i++) {
		tracker.queryRpcStatus();
	}
	// 3 base listeners + exactly 1 latest active request listener = 4 (no accumulation of 20 listeners)
	assert.equal(bus.listeners.size, 4);
	tracker.dispose();
	assert.equal(bus.listeners.size, 0);
});

test("SubagentTracker safely rejects non-finite RPC counts", () => {
	class TrackedMockBus {
		listeners = new Map<string, (data: unknown) => void>();
		emitted: Array<{ event: string; data: unknown }> = [];
		on(event: string, handler: (data: unknown) => void) {
			this.listeners.set(event, handler);
			return () => this.listeners.delete(event);
		}
		emit(event: string, data: unknown) {
			this.emitted.push({ event, data });
		}
	}
	const bus = new TrackedMockBus();
	let lastCount = 0;
	const tracker = new SubagentTracker({
		events: bus,
		sessionId: "non-finite",
		onCountChange: (c) => { lastCount = c; },
	});

	tracker.queryRpcStatus();
	const req = bus.emitted[0].data as { requestId: string };
	const replyHandler = bus.listeners.get(`subagents:rpc:v1:reply:${req.requestId}`);
	assert.ok(replyHandler);

	// Deliver NaN
	replyHandler({ ok: true, result: { fleet: { totalActive: Number.NaN } } });
	assert.equal(tracker.getTotalActiveCount(), 0);
	assert.equal(lastCount, 0);

	tracker.dispose();
});

test("DiscordPresenceManager coalesces burst registry updates into minimal disk operations", async () => {
	let upsertCount = 0;
	const store = {
		state: { version: 1 as const, sessions: {} as Record<string, SessionRecord>, updatedAt: 0, publisherGeneration: 1 },
		async upsert(record: SessionRecord) {
			upsertCount++;
			this.state.sessions[record.sessionId] = record;
			return structuredClone(this.state);
		},
		async read() { return structuredClone(this.state); },
		async remove(id: string) { delete this.state.sessions[id]; return structuredClone(this.state); },
		async withPublisherLock<T>() { return undefined as unknown as T; },
	};
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "coalesce-bench",
		stateStore: store,
		logger: () => {},
	});

	await manager.start();
	upsertCount = 0;

	// Fire 100 updates concurrently
	await Promise.all(Array.from({ length: 100 }, (_, i) => manager.setPhase(i % 2 ? "thinking" : "idle")));
	// Should be coalesced into 1 (or at most 2) upserts, not 100!
	assert.ok(upsertCount <= 2, `expected <= 2 upserts, got ${upsertCount}`);
	assert.equal(store.state.sessions[manager.getSessionId()].phase, "thinking");

	await manager.stop();
});

test("DiscordPresenceManager stop cancels pending throttle timer without deadlock", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const stateStore = new MemoryStateStore();
	const transport = new MockTransport();
	const manager = new DiscordPresenceManager({
		clientId: CLIENT_ID,
		projectName: "stop-throttle",
		minPublishIntervalMs: 5000,
		stateStore,
		createTransport: () => transport,
		logger: () => {},
	});

	await manager.start();
	assert.equal(transport.activities.length, 1);

	// Advance 1s and set phase; this schedules a 4s throttle timer
	t.mock.timers.tick(1000);
	await manager.setPhase("thinking");
	await manager.refresh();

	// Stop while throttle is pending; stop must resolve promptly and not deadlock!
	await manager.stop();
	assert.equal(manager.getStatus(), "stopped");
});
