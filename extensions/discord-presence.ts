/**
 * Discord Rich Presence for Pi Coding Agent (v2).
 *
 * The extension publishes a privacy-safe, adaptive Discord Rich Presence
 * for all active Pi sessions. It presents single sessions and multi-session
 * workloads with dedicated layouts and human-readable model labels, while
 * preserving strict privacy guarantees: it never sends prompts, paths,
 * filenames, commands, or tool arguments.
 *
 * Each session contributes project/model/action/usage metadata to a shared
 * registry; one elected session owns the Discord RPC connection.
 *
 * A public default Discord application ID is included; PI_DISCORD_CLIENT_ID
 * can override it. Discord Desktop must be running in the background.
 */

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
import os from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
	Client,
	Transport,
	type ClientOptions,
	type CommandIncoming,
	type SetActivity,
	type TransportOptions,
} from "@xhayper/discord-rpc";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CLIENT_ID_ENV = "PI_DISCORD_CLIENT_ID";
export const PRIVACY_ENV = "PI_DISCORD_PRIVACY";
export const BUTTONS_ENV = "PI_DISCORD_BUTTONS";
export const LARGE_IMAGE_ENV = "PI_DISCORD_LARGE_IMAGE";
export const SMALL_IMAGES_ENV = "PI_DISCORD_SMALL_IMAGES";
export const SHOW_COST_ENV = "PI_DISCORD_SHOW_COST";
export const ENABLED_ENV = "PI_DISCORD_ENABLED";

export const TRANSPORT_ENV = "PI_DISCORD_TRANSPORT";
export const NPIPERELAY_ENV = "PI_DISCORD_NPIPERELAY";

export type DiscordTransportMode = "ipc" | "wsl-relay";

/** Detect WSL without treating ordinary Linux as a Windows host. */
export function isWslEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	kernelRelease = os.release(),
): boolean {
	if (platform !== "linux") return false;
	const release = kernelRelease.toLowerCase();
	return Boolean(
		env.WSL_INTEROP ||
		env.WSL_DISTRO_NAME ||
		release.includes("microsoft") ||
		release.includes("wsl"),
	);
}

/** Resolve the RPC transport, allowing an explicit override for unusual setups. */
export function resolveDiscordTransportMode(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	kernelRelease = os.release(),
): DiscordTransportMode {
	const configured = env[TRANSPORT_ENV]?.trim().toLowerCase();
	if (configured === "ipc") return "ipc";
	if (
		configured === "wsl" ||
		configured === "wsl-relay" ||
		configured === "relay" ||
		configured === "npiperelay"
	)
		return "wsl-relay";
	return isWslEnvironment(env, platform, kernelRelease) ? "wsl-relay" : "ipc";
}

export const DEFAULT_CLIENT_ID = "1541350417143955466";
export const DEFAULT_LARGE_IMAGE_KEY =
	"https://cdn.discordapp.com/app-icons/1541350417143955466/71bb55a3b54d84642419948a680f22e4.png";
export const DEFAULT_LARGE_IMAGE_TEXT = "Pi Coding Agent";

const PHOSPHOR_BADGE_BASE_URL = "https://api.iconify.design/ph";
const PHOSPHOR_BADGE_PROXY_URL = "https://wsrv.nl/";
const PHOSPHOR_BADGE_SIZE = 72;

function phosphorDuotoneBadge(icon: string, color: string): string {
	const sourceUrl = `${PHOSPHOR_BADGE_BASE_URL}/${icon}-duotone.svg?color=${encodeURIComponent(
		color,
	)}&width=${PHOSPHOR_BADGE_SIZE}&height=${PHOSPHOR_BADGE_SIZE}`;
	return `${PHOSPHOR_BADGE_PROXY_URL}?url=${encodeURIComponent(
		sourceUrl,
	)}&output=png&w=${PHOSPHOR_BADGE_SIZE}&h=${PHOSPHOR_BADGE_SIZE}`;
}

/** One vivid, high-contrast color per presence action. */
export const ACTION_BADGE_COLORS: Record<PresenceAction, string> = {
	thinking: "#ff375f",
	testing: "#ff9f0a",
	editing: "#0a84ff",
	searching: "#00c7be",
	reading: "#bf5af2",
	running: "#30d158",
	browsing: "#5e5ce6",
	tools: "#ffd60a",
	idle: "#ffffff",
};

const ACTION_PHOSPHOR_ICONS: Record<PresenceAction, string> = {
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

export const ACTION_BADGE_URLS: Record<PresenceAction, string> =
	Object.fromEntries(
		(Object.keys(ACTION_PHOSPHOR_ICONS) as PresenceAction[]).map((action) => [
			action,
			phosphorDuotoneBadge(
				ACTION_PHOSPHOR_ICONS[action],
				ACTION_BADGE_COLORS[action],
			),
		]),
	) as Record<PresenceAction, string>;

/** @deprecated Use ACTION_BADGE_URLS instead. */
export const ACTION_EMOJI_BADGE_URLS = ACTION_BADGE_URLS;

export const DEFAULT_BUTTONS: Array<{ label: string; url: string }> = [
	{
		label: "Pi Extensions",
		url: "https://github.com/Th1nhNg0/pi-extensions",
	},
	{
		label: "Pi Coding Agent",
		url: "https://pi.dev",
	},
];

export const DEFAULT_STATE_PATH = join(
	os.homedir(),
	".pi",
	"agent",
	"discord-presence-state.json",
);

export const DEFAULT_PREFS_PATH = join(
	os.homedir(),
	".pi",
	"agent",
	"discord-presence-prefs.json",
);

const MAX_ACTIVITY_TEXT_LENGTH = 128;
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_SESSION_MS = 30_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 15_000;
const LOCK_LEASE_REFRESH_MS = Math.max(1_000, Math.floor(LOCK_STALE_MS / 3));
const LOCK_RETRY_MS = 25;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 5 * 60_000;
const RPC_WRITE_TIMEOUT_MS = 10_000;

type GitCommandResult = {
	stdout: string;
	code: number;
};

export type PresencePhase = "thinking" | "tools" | "idle";

export type PresenceAction =
	| "thinking"
	| "searching"
	| "reading"
	| "editing"
	| "running"
	| "testing"
	| "browsing"
	| "tools"
	| "idle";

export type PresencePrivacyMode = "strict" | "project" | "developer";
export const PRIVACY_MODES: readonly PresencePrivacyMode[] = [
	"strict",
	"project",
	"developer",
];

export interface DiscordPresencePrefs {
	privacyMode?: PresencePrivacyMode;
	enabled?: boolean;
	showCost?: boolean;
	buttons?: boolean;
	assets?: boolean;
	largeImage?: string;
	smallImages?: string;
}

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
	action?: PresenceAction;
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

export interface ActivityBuildOptions {
	privacyMode?: PresencePrivacyMode;
	showCost?: boolean;
	clientId?: string;
	enableButtons?: boolean;
	enableAssets?: boolean;
	largeImageKey?: string;
	largeImageText?: string;
	smallImageKey?: string;
	smallImageText?: string;
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
	privacyMode?: PresencePrivacyMode;
	showCost?: boolean;
	enableButtons?: boolean;
	enableAssets?: boolean;
	largeImageKey?: string;
	smallImageKey?: string;
}

function defaultLogger(message: string): void {
	process.stderr.write(`${message}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
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

export async function readPrefs(
	filePath = DEFAULT_PREFS_PATH,
): Promise<DiscordPresencePrefs> {
	try {
		const raw = JSON.parse(await readFile(filePath, "utf8"));
		return (asRecord(raw) as DiscordPresencePrefs) ?? {};
	} catch {
		return {};
	}
}

export async function writePrefs(
	prefs: DiscordPresencePrefs,
	filePath = DEFAULT_PREFS_PATH,
): Promise<void> {
	try {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(prefs, null, 2), "utf8");
	} catch {
		// Non-fatal if the filesystem is read-only
	}
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
	const percent =
		percentValue === null ? null : (finiteNumber(percentValue) ?? null);
	return {
		tokens:
			tokensValue === null ? null : (finiteNonNegative(tokensValue) ?? null),
		contextWindow,
		percent: percent === null ? null : Math.min(100, Math.max(0, percent)),
	};
}

export interface AggregateSummary {
	usage: UsageTotals;
	projectCount: number;
	startTimestamp: number;
}

function summarizeRecords(records: readonly SessionRecord[]): AggregateSummary {
	const usage = emptyUsageTotals();
	const projects = new Set<string>();
	let startTimestamp = Number.POSITIVE_INFINITY;
	for (const record of records) {
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
	}
	return {
		usage,
		projectCount: projects.size,
		startTimestamp: Number.isFinite(startTimestamp) ? startTimestamp : Date.now(),
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

export function truncateText(
	value: string,
	maxLength = MAX_ACTIVITY_TEXT_LENGTH,
): string {
	const safeValue = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(safeValue);
	if (characters.length <= maxLength) return safeValue;
	return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
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

export function parsePrivacyMode(
	value: string | undefined,
): PresencePrivacyMode {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "project") return "project";
	if (normalized === "developer") return "developer";
	return "strict";
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

export function formatAction(
	action?: PresenceAction,
	phase: PresencePhase = "idle",
): string {
	const effectiveAction = action ?? (phase === "tools" ? "tools" : phase);
	switch (effectiveAction) {
		case "thinking":
			return "Thinking";
		case "searching":
			return "Searching";
		case "reading":
			return "Reading";
		case "editing":
			return "Editing";
		case "running":
			return "Running command";
		case "testing":
			return "Running tests";
		case "browsing":
			return "Browsing";
		case "tools":
			return "Using tools";
		case "idle":
			return "Idle";
		default:
			return formatPhase(phase);
	}
}

/**
 * Pure tool action classifier based only on the tool name identifier.
 * NEVER inspects tool arguments, command strings, filenames, or outputs.
 */
export function classifyToolAction(
	toolName: string | undefined,
): PresenceAction {
	if (!toolName) return "tools";
	const normalized = toolName.trim().toLowerCase().replace(/[-_]/g, " ");

	// Test tools
	if (
		normalized.includes("test") ||
		normalized.includes("jest") ||
		normalized.includes("pytest") ||
		normalized.includes("vitest")
	) {
		return "testing";
	}

	// Edit / write / patch tools
	if (
		normalized.includes("edit") ||
		normalized.includes("write") ||
		normalized.includes("patch") ||
		normalized.includes("replace") ||
		normalized.includes("create file") ||
		normalized.includes("update file")
	) {
		return "editing";
	}

	// Browser / web tools (distinct from search)
	if (
		normalized.includes("browser") ||
		normalized.includes("playwright") ||
		normalized.includes("puppeteer") ||
		normalized === "web" ||
		normalized.startsWith("browse")
	) {
		return "browsing";
	}

	// Search / grep / find tools
	if (
		normalized.includes("grep") ||
		normalized.includes("search") ||
		normalized.includes("find") ||
		normalized.includes("ripgrep") ||
		normalized.includes("lookup") ||
		normalized === "rg" ||
		normalized.includes("source check")
	) {
		return "searching";
	}

	// Read / view / inspect tools
	if (
		normalized.includes("read") ||
		normalized.includes("view") ||
		normalized.includes("cat") ||
		normalized.includes("fetch") ||
		normalized.includes("open")
	) {
		return "reading";
	}

	// Shell / command / execution tools
	if (
		normalized.includes("bash") ||
		normalized.includes("shell") ||
		normalized.includes("exec") ||
		normalized.includes("powershell") ||
		normalized.includes("cmd") ||
		normalized.includes("terminal") ||
		normalized.includes("command") ||
		normalized.includes("process") ||
		normalized.includes("spawn") ||
		normalized === "sh" ||
		normalized === "zsh"
	) {
		return "running";
	}

	return "tools";
}

const ACTION_PRIORITY: Record<PresenceAction, number> = {
	testing: 7,
	editing: 6,
	browsing: 5,
	searching: 4,
	reading: 3,
	running: 2,
	tools: 1,
	thinking: 0,
	idle: 0,
};

export function pickHighestPriorityAction(
	actions: Iterable<PresenceAction>,
): PresenceAction {
	let bestAction: PresenceAction = "tools";
	let highestPriority = -1;
	for (const action of actions) {
		const priority = ACTION_PRIORITY[action] ?? 0;
		if (priority > highestPriority) {
			highestPriority = priority;
			bestAction = action;
		}
	}
	return highestPriority >= 0 ? bestAction : "tools";
}

/** Diagnostic full model label (e.g. `openai-codex/gpt-5`). */
export function formatModelLabel(provider?: string, modelId?: string): string {
	const label =
		provider && modelId
			? `${provider}/${modelId}`
			: (modelId ?? provider ?? "Pi");
	return truncateText(label, 96);
}

const KNOWN_PREFIXES: Array<[RegExp, string]> = [
	[/^gpt-/i, "GPT-"],
	[/^claude-/i, "Claude "],
	[/^gemini-/i, "Gemini "],
	[/^deepseek-/i, "DeepSeek "],
	[/^glm-/i, "GLM-"],
	[/^qwen-/i, "Qwen "],
	[/^llama-/i, "Llama "],
	[/^mistral-/i, "Mistral "],
	[/^codestral/i, "Codestral"],
	[/^kimi-/i, "Kimi "],
];

const KNOWN_WORDS: Record<string, string> = {
	gpt: "GPT",
	glm: "GLM",
	r1: "R1",
	v3: "V3",
	v2: "V2",
	v1: "V1",
	pro: "Pro",
	flash: "Flash",
	sonnet: "Sonnet",
	opus: "Opus",
	haiku: "Haiku",
	turbo: "Turbo",
	coder: "Coder",
	chat: "Chat",
	exp: "Exp",
	preview: "Preview",
	instruct: "Instruct",
	mini: "mini",
	large: "Large",
	small: "Small",
	medium: "Medium",
	plus: "Plus",
	thinking: "Thinking",
};

function formatProviderFallback(provider: string): string {
	const normalized = provider.trim().toLowerCase();
	switch (normalized) {
		case "openai-codex":
			return "OpenAI Codex";
		case "openai":
			return "OpenAI";
		case "anthropic":
			return "Anthropic";
		case "google":
			return "Google";
		case "deepseek":
			return "DeepSeek";
		case "mistral":
			return "Mistral";
		case "ollama":
			return "Ollama";
		case "github":
			return "GitHub";
		default:
			return formatModelWords(provider, true);
	}
}

function formatModelWords(value: string, _capitalizeFirst = true): string {
	const tokens = value
		.replace(/[_]/g, " ")
		.split(/[-\s]+/)
		.filter(Boolean);

	return tokens
		.map((token, index) => {
			const lower = token.toLowerCase();
			if (KNOWN_WORDS[lower]) {
				if (lower === "mini" && index > 0) return "mini";
				return KNOWN_WORDS[lower];
			}
			if (/^\d+[bBkKmMgG]$/.test(token)) {
				return token.toUpperCase();
			}
			if (/^\d+(\.\d+)?$/.test(token)) return token;
			return token.charAt(0).toUpperCase() + token.slice(1);
		})
		.join(" ");
}

/** Human-readable model label for Discord Rich Presence. */
export function formatDiscordModelLabel(
	provider?: string,
	modelId?: string,
): string {
	if (!modelId?.trim()) {
		if (!provider?.trim()) return "Pi";
		return formatProviderFallback(provider);
	}

	let raw = modelId.trim();
	if (raw.includes("/")) {
		raw = raw.slice(raw.lastIndexOf("/") + 1).trim();
	}

	// Preserve openai o-series models (e.g. o1, o3, o3-mini, o4-mini, o1-preview)
	if (/^o\d(-[a-z0-9]+)?$/i.test(raw)) {
		return raw.toLowerCase();
	}

	// Convert version numbers separated by dashes (e.g. 4-1 -> 4.1, 3-7 -> 3.7, 2-5 -> 2.5)
	const transformed = raw.replace(
		/(?<=[a-zA-Z]|^)-(\d+)-(\d+)(?=-|[a-zA-Z]|$)/g,
		"-$1.$2",
	);

	for (const [pattern, prefix] of KNOWN_PREFIXES) {
		if (pattern.test(transformed)) {
			const rest = transformed.replace(pattern, "");
			if (prefix.endsWith("-")) {
				return truncateText(`${prefix}${formatModelWords(rest, false)}`, 48);
			}
			return truncateText(`${prefix}${formatModelWords(rest, true)}`, 48);
		}
	}

	return truncateText(formatModelWords(transformed, true), 48);
}

export function formatPublicMetrics(
	usage: UsageTotals,
	context?: ContextSnapshot,
	_privacy: PresencePrivacyMode = "strict",
	showCost = true,
): string {
	const parts: string[] = [];
	parts.push(`${formatTokenCount(usage.total)} tok`);

	if (context && context.percent !== null && Number.isFinite(context.percent)) {
		const clampedPercent = Math.min(
			100,
			Math.max(0, Math.round(context.percent)),
		);
		parts.push(`ctx ${clampedPercent}%`);
	}

	// Show cost by default when available
	if (showCost && usage.cost !== undefined) {
		const prefix = usage.costComplete ? "$" : "~$";
		parts.push(`${prefix}${usage.cost.toFixed(2)}`);
	}

	return parts.join(" · ");
}

export function formatSingleSessionDetails(record: SessionRecord): string {
	const actionText = formatAction(record.action, record.phase);
	const modelText = formatDiscordModelLabel(record.provider, record.modelId);
	return truncateText(`${actionText} · ${modelText}`);
}

export function formatSingleSessionState(
	record: SessionRecord,
	privacy: PresencePrivacyMode = "strict",
	showCost = true,
): string {
	const metrics = formatPublicMetrics(
		record.usage,
		record.context,
		privacy,
		showCost,
	);
	if (privacy === "project" || privacy === "developer") {
		const project = truncateText(record.projectName || "project", 48);
		return truncateText(`${project} · ${metrics}`);
	}
	return truncateText(metrics);
}

export function summarizeModels(records: readonly SessionRecord[]): string {
	if (records.length === 0) return "Pi";
	const labels = new Set(
		records.map((r) => formatDiscordModelLabel(r.provider, r.modelId)),
	);
	if (labels.size === 1) return labels.values().next().value!;
	return "multiple models";
}

export function formatMultiSessionDetails(
	summary: AggregateSummary,
	sessionCount: number,
	showCost = true,
): string {
	const costPart =
		showCost && summary.usage.cost !== undefined
			? ` · ${formatCost(summary.usage)}`
			: "";
	return truncateText(
		`${sessionCount} Pi sessions · ${formatTokenCount(summary.usage.total)} tok${costPart}`,
	);
}

export function formatMultiSessionState(
	records: readonly SessionRecord[],
	projectCount: number,
): string {
	const activeCount = records.filter((r) => r.phase !== "idle").length;
	const activeLabel =
		activeCount === 0 ? `${records.length} idle` : `${activeCount} active`;
	const modelLabel = summarizeModels(records);
	const projectLabel = `${projectCount} project${projectCount === 1 ? "" : "s"}`;
	return truncateText(`${activeLabel} · ${modelLabel} · ${projectLabel}`);
}

export function attachAssetsAndButtons(
	activity: SetActivity,
	action?: PresenceAction,
	phase: PresencePhase = "idle",
	options: ActivityBuildOptions = {},
): void {
	const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
	const isDefaultClient = clientId === DEFAULT_CLIENT_ID;

	const largeImageEnv = options.largeImageKey ?? process.env[LARGE_IMAGE_ENV];
	const smallImagesEnv = options.smallImageKey ?? process.env[SMALL_IMAGES_ENV];

	const largeDisabled =
		options.enableAssets === false ||
		largeImageEnv === "off" ||
		largeImageEnv === "false" ||
		largeImageEnv === "none" ||
		largeImageEnv === "0";

	const smallDisabled =
		options.enableAssets === false ||
		smallImagesEnv === "off" ||
		smallImagesEnv === "false" ||
		smallImagesEnv === "none" ||
		smallImagesEnv === "0";

	const canUseAssets =
		options.enableAssets === true ||
		isDefaultClient ||
		Boolean(largeImageEnv) ||
		Boolean(smallImagesEnv);

	if (canUseAssets && !largeDisabled) {
		let largeKey = DEFAULT_LARGE_IMAGE_KEY;
		if (
			largeImageEnv &&
			largeImageEnv !== "on" &&
			largeImageEnv !== "true" &&
			largeImageEnv !== "1" &&
			largeImageEnv !== "auto"
		) {
			largeKey = largeImageEnv;
		}
		const largeText = options.largeImageText ?? DEFAULT_LARGE_IMAGE_TEXT;

		if (largeKey.startsWith("http://") || largeKey.startsWith("https://")) {
			activity.largeImageUrl = largeKey;
			activity.largeImageKey = largeKey;
		} else {
			activity.largeImageKey = largeKey;
		}
		activity.largeImageText = truncateText(largeText, 128);
	}

	if (canUseAssets && !smallDisabled) {
		const effectiveAction = action ?? (phase === "tools" ? "tools" : phase);
		let smallKey: string =
			ACTION_BADGE_URLS[effectiveAction] ?? ACTION_BADGE_URLS.tools;
		if (
			smallImagesEnv &&
			smallImagesEnv !== "on" &&
			smallImagesEnv !== "true" &&
			smallImagesEnv !== "1" &&
			smallImagesEnv !== "auto"
		) {
			smallKey = smallImagesEnv;
		}

		const smallText =
			options.smallImageText ?? formatAction(effectiveAction, phase);

		if (smallKey.startsWith("http://") || smallKey.startsWith("https://")) {
			activity.smallImageUrl = smallKey;
			activity.smallImageKey = smallKey;
		} else {
			activity.smallImageKey = smallKey;
		}
		activity.smallImageText = truncateText(smallText, 128);

		// If a small image is set, Discord requires large_image to be present too
		if (!activity.largeImageKey && !largeDisabled) {
			activity.largeImageKey = DEFAULT_LARGE_IMAGE_KEY;
			activity.largeImageText = DEFAULT_LARGE_IMAGE_TEXT;
		}
	}

	const buttonsEnv = process.env[BUTTONS_ENV];
	const buttonsDisabled =
		options.enableButtons === false ||
		buttonsEnv === "off" ||
		buttonsEnv === "false" ||
		buttonsEnv === "none" ||
		buttonsEnv === "0";

	if (!buttonsDisabled) {
		activity.buttons = DEFAULT_BUTTONS;
	}
}

export function buildSingleSessionActivity(
	record: SessionRecord,
	options: ActivityBuildOptions = {},
): PresenceActivity {
	const privacy = options.privacyMode ?? "strict";
	const showCost = options.showCost ?? true;
	const details = formatSingleSessionDetails(record);
	const state = formatSingleSessionState(record, privacy, showCost);

	const activity: PresenceActivity = {
		details,
		state,
		startTimestamp: record.startedAt,
		instance: true,
	};

	attachAssetsAndButtons(activity, record.action, record.phase, options);
	return activity;
}

export function buildMultiSessionActivity(
	state: PresenceState,
	options: ActivityBuildOptions = {},
): PresenceActivity {
	const records = orderedSessions(state);
	if (records.length === 0) {
		return {
			details: "0 Pi sessions · 0 tok",
			state: "Pi · Idle",
			startTimestamp: Date.now(),
			instance: true,
		};
	}

	const primary = records[0];
	const summary = summarizeRecords(records);
	const showCost = options.showCost ?? true;
	const details = formatMultiSessionDetails(summary, records.length, showCost);
	const activityState = formatMultiSessionState(records, summary.projectCount);

	const activity: PresenceActivity = {
		details,
		state: activityState,
		startTimestamp: summary.startTimestamp,
		instance: true,
	};

	attachAssetsAndButtons(activity, primary.action, primary.phase, options);
	return activity;
}

export function buildAggregateActivity(
	state: PresenceState,
	options: ActivityBuildOptions = {},
): PresenceActivity {
	const records = orderedSessions(state);
	if (records.length === 0) {
		return {
			details: "0 Pi sessions · 0 tok",
			state: "Pi · Idle",
			startTimestamp: Date.now(),
			instance: true,
		};
	}
	if (records.length === 1) {
		return buildSingleSessionActivity(records[0], options);
	}
	return buildMultiSessionActivity(state, options);
}

export interface PresenceSnapshot {
	projectName: string;
	provider?: string;
	modelId?: string;
	phase: PresencePhase;
	action?: PresenceAction;
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
		action: snapshot.action,
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

export function buildActivity(
	snapshot: PresenceSnapshot,
	options: ActivityBuildOptions = {},
): PresenceActivity {
	return buildAggregateActivity(
		{
			version: 1,
			publisherId: "current",
			publisherGeneration: 1,
			sessions: { current: snapshotRecord(snapshot) },
			updatedAt: snapshot.startedAt,
		},
		options,
	);
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

const validActions = new Set<string>([
	"thinking",
	"searching",
	"reading",
	"editing",
	"running",
	"testing",
	"browsing",
	"tools",
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
		action: parseAction(record.action),
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

const DISCORD_PIPE_COUNT = 10;
const RELAY_CONNECT_TIMEOUT_MS = 1_000;
const MAX_RELAY_PAYLOAD_BYTES = 16 * 1024 * 1024;

function isReadyRpcMessage(message: unknown): boolean {
	const record = asRecord(message);
	return record?.cmd === "DISPATCH" && record.evt === "READY";
}

function isMissingExecutableError(error: unknown): boolean {
	return asRecord(error)?.code === "ENOENT";
}

/**
 * Bridges Discord's Windows named pipe into WSL through npiperelay.exe.
 *
 * WSL cannot open \\.\\pipe\\discord-ipc-* directly. npiperelay is a small
 * Windows executable that copies the pipe bytes to stdin/stdout, so this
 * transport can keep the normal Discord IPC framing and authentication.
 */
export class WslDiscordIpcTransport extends Transport {
	private readonly relayCommand =
		process.env[NPIPERELAY_ENV]?.trim() || "npiperelay.exe";
	private relay: ChildProcess | undefined;
	private incoming = Buffer.alloc(0);
	private connected = false;
	private closing = false;

	constructor(options: TransportOptions) {
		super(options);
	}

	override get isConnected(): boolean {
		return this.connected;
	}

	override async connect(): Promise<void> {
		if (this.connected) return;

		let lastError: unknown;
		for (let pipeId = 0; pipeId < DISCORD_PIPE_COUNT; pipeId += 1) {
			try {
				await this.connectPipe(pipeId);
				return;
			} catch (error) {
				lastError = error;
				if (isMissingExecutableError(error)) {
					throw new Error(
						`WSL Discord support requires npiperelay.exe. Put it on PATH or set ${NPIPERELAY_ENV} to its Windows path.`,
					);
				}
			}
		}

		const detail =
			lastError instanceof Error ? ` (${lastError.message})` : "";
		throw new Error(
			`Could not connect to Windows Discord through ${this.relayCommand}. Ensure Discord Desktop is running.${detail}`,
		);
	}

	private connectPipe(pipeId: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const pipePath = `//./pipe/discord-ipc-${pipeId}`;
			const relay = spawn(this.relayCommand, ["-ep", pipePath], {
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
			});
			this.relay = relay;

			let settled = false;
			let ready = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const clearAttempt = (): void => {
				if (timer) clearTimeout(timer);
				timer = undefined;
				this.removeListener("message", onMessage);
			};

			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				clearAttempt();
				relay.stdout?.removeListener("data", onData);
				relay.removeListener("spawn", onSpawn);
				relay.removeListener("error", onError);
				relay.removeListener("close", onClose);
				if (this.relay === relay) {
					this.relay = undefined;
					this.connected = false;
					this.incoming = Buffer.alloc(0);
				}
				relay.kill();
				reject(error instanceof Error ? error : new Error(String(error)));
			};

			const succeed = (): void => {
				if (settled) return;
				settled = true;
				ready = true;
				clearAttempt();
				resolve();
			};

			const onMessage = (message: unknown): void => {
				if (isReadyRpcMessage(message)) succeed();
			};

			const onData = (chunk: Buffer | string): void => {
				this.handleIncomingData(
					Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
				);
			};

			const onSpawn = (): void => {
				this.connected = true;
				this.emit("open");
				try {
					this.writePacket(
						{ v: 1, client_id: this.client.clientId },
						0,
					);
				} catch (error) {
					fail(error);
				}
			};

			const onError = (error: Error): void => {
				if (!settled) fail(error);
			};

			const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
				if (!ready) {
					fail(
						new Error(
							`npiperelay exited before Discord IPC became ready (code ${code ?? "none"}, signal ${signal ?? "none"})`,
						),
					);
					return;
				}
				if (this.relay === relay) {
					this.relay = undefined;
					this.connected = false;
					this.incoming = Buffer.alloc(0);
				}
				if (!this.closing) this.emit("close", "Windows Discord IPC closed");
			};

			this.on("message", onMessage);
			relay.stdout?.on("data", onData);
			relay.once("spawn", onSpawn);
			relay.once("error", onError);
			relay.once("close", onClose);
			timer = setTimeout(() => {
				fail(`Timed out connecting to Discord IPC pipe ${pipeId}`);
			}, RELAY_CONNECT_TIMEOUT_MS);
		});
	}

	private handleIncomingData(chunk: Buffer): void {
		this.incoming = Buffer.concat([this.incoming, chunk]);
		while (this.incoming.length >= 8) {
			const opcode = this.incoming.readUInt32LE(0);
			const payloadLength = this.incoming.readUInt32LE(4);
			if (payloadLength > MAX_RELAY_PAYLOAD_BYTES) {
				this.relay?.kill();
				return;
			}
			if (this.incoming.length < payloadLength + 8) return;

			const payload = this.incoming
				.subarray(8, payloadLength + 8)
				.toString("utf8");
			this.incoming = this.incoming.subarray(payloadLength + 8);

			let message: unknown;
			try {
				message = JSON.parse(payload);
			} catch {
				this.relay?.kill();
				return;
			}

			switch (opcode) {
				case 1:
					this.emit("message", message as CommandIncoming);
					break;
				case 2: {
					let reason: string | { code: number; message: string } | undefined;
					if (typeof message === "string") {
						reason = message;
					} else {
						const record = asRecord(message);
						if (
							typeof record?.code === "number" &&
							typeof record.message === "string"
						)
							reason = { code: record.code, message: record.message };
					}
					this.emit("close", reason);
					break;
				}
				case 3:
					this.writePacket(message, 4);
					break;
				default:
					break;
			}
		}
	}

	private writePacket(message: unknown, opcode: number): void {
		const stdin = this.relay?.stdin;
		if (!stdin || stdin.destroyed)
			throw new Error("The npiperelay stdin stream is unavailable");
		const payload = Buffer.from(JSON.stringify(message) ?? "");
		const packet = Buffer.alloc(8);
		packet.writeUInt32LE(opcode, 0);
		packet.writeUInt32LE(payload.length, 4);
		stdin.write(Buffer.concat([packet, payload]));
	}

	override send(message?: unknown): void {
		this.writePacket(message, 1);
	}

	override ping(): void {
		this.writePacket(randomUUID(), 3);
	}

	override async close(): Promise<void> {
		const relay = this.relay;
		this.relay = undefined;
		this.connected = false;
		this.incoming = Buffer.alloc(0);
		if (!relay) return;

		this.closing = true;
		await new Promise<void>((resolve) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				this.closing = false;
				this.emit("close", "Closed by client");
				resolve();
			};
			relay.once("close", finish);
			relay.once("error", finish);
			if (relay.exitCode !== null) {
				finish();
				return;
			}
			relay.kill();
			timer = setTimeout(() => {
				relay.kill("SIGKILL");
				finish();
			}, 1_000);
			timer.unref?.();
		});
	}
}

export function createDiscordPresenceTransport(
	clientId: string,
): DiscordPresenceTransport {
	const transportMode = resolveDiscordTransportMode();
	const clientOptions: ClientOptions =
		transportMode === "wsl-relay"
			? { clientId, transport: { type: WslDiscordIpcTransport } }
			: { clientId };
	const client = new Client(clientOptions);
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
	private privacyMode: PresencePrivacyMode;
	private showCost: boolean;
	private enableButtons?: boolean;
	private enableAssets?: boolean;
	private largeImageKey?: string;
	private smallImageKey?: string;
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
	private presenceDrain: Promise<void> | undefined;
	private pendingPresenceState: PresenceState | undefined;
	private outageWarningShown = false;
	private transportErrorWarningShown = false;
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
		this.privacyMode =
			options.privacyMode ?? parsePrivacyMode(process.env[PRIVACY_ENV]);
		this.showCost = options.showCost ?? true;
		this.enableButtons = options.enableButtons;
		this.enableAssets = options.enableAssets;
		this.largeImageKey = options.largeImageKey;
		this.smallImageKey = options.smallImageKey;
		const startedAt = options.startedAt ?? this.now();
		this.record = {
			sessionId: this.sessionId,
			projectName: options.projectName,
			provider: options.provider,
			modelId: options.modelId,
			phase: "idle",
			action: "idle",
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

	getPrivacyMode(): PresencePrivacyMode {
		return this.privacyMode;
	}

	setPrivacyMode(mode: PresencePrivacyMode): Promise<void> {
		this.privacyMode = mode;
		return this.refresh();
	}

	setShowCost(showCost: boolean): Promise<void> {
		this.showCost = showCost;
		return this.refresh();
	}

	setEnableButtons(enable: boolean | undefined): Promise<void> {
		this.enableButtons = enable;
		return this.refresh();
	}

	setEnableAssets(enable: boolean | undefined): Promise<void> {
		this.enableAssets = enable;
		return this.refresh();
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

	setPhase(phase: PresencePhase, action?: PresenceAction): Promise<void> {
		this.record.phase = phase;
		this.record.action = action ?? (phase === "tools" ? "tools" : phase);
		return this.enqueueRegistryUpdate();
	}

	setAction(action?: PresenceAction): Promise<void> {
		this.record.action = action;
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
			? truncateText(
					state.sessions[state.publisherId]?.projectName ?? "unknown",
					96,
				)
			: "none";
		const lines = [
			`Discord presence: ${this.getStatusText()} · Privacy: ${this.privacyMode}`,
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
		this.pendingPresenceState = state;
		if (this.presenceDrain) return this.presenceDrain;

		const drain = (async () => {
			while (this.pendingPresenceState) {
				const nextState = this.pendingPresenceState;
				this.pendingPresenceState = undefined;
				try {
					await this.publish(nextState);
				} catch {
					// Presence failures are deliberately non-fatal to Pi.
				}
			}
		})();
		this.presenceDrain = drain;
		this.presenceQueue = drain;
		void drain.then(
			() => {
				if (this.presenceDrain !== drain) return;
				this.presenceDrain = undefined;
				if (this.pendingPresenceState && !this.disposed)
					this.enqueuePresencePublish(this.pendingPresenceState);
			},
			() => {
				if (this.presenceDrain === drain) this.presenceDrain = undefined;
			},
		);
		return drain;
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
					const activity = buildAggregateActivity(state, {
						privacyMode: this.privacyMode,
						showCost: this.showCost,
						clientId: this.clientId,
						enableButtons: this.enableButtons,
						enableAssets: this.enableAssets,
						largeImageKey: this.largeImageKey,
						smallImageKey: this.smallImageKey,
					});
					await awaitWithTimeout(
						transport.setActivity(activity),
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
			await this.handleUnavailable(transport);
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
		} catch (error) {
			if (!this.transportErrorWarningShown) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger(`[discord-presence] ${message}`);
				this.transportErrorWarningShown = true;
			}
			await this.handleUnavailable();
			return false;
		}

		this.transport = transport;
		this.removeDisconnectedListener = transport.onDisconnected?.(() => {
			if (this.transport !== transport || this.disposed || !this.publisher) return;
			void this.handleUnavailable(transport);
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
				await this.closeTransport(transport);
				return false;
			}
			this.transportErrorWarningShown = false;
			return true;
		} catch (error) {
			if (!this.transportErrorWarningShown) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger(`[discord-presence] ${message}`);
				this.transportErrorWarningShown = true;
			}
			await this.handleUnavailable(transport);
			return false;
		}
	}

	private async handleUnavailable(
		expectedTransport?: DiscordPresenceTransport,
	): Promise<void> {
		if (
			this.disposed ||
			!this.started ||
			!this.publisher ||
			(expectedTransport && this.transport !== expectedTransport)
		)
			return;
		this.status = "reconnecting";
		if (!this.outageWarningShown) {
			this.logger(
				"[discord-presence] Discord Desktop is unavailable; retrying in the background.",
			);
			this.outageWarningShown = true;
		}
		await this.closeTransport(expectedTransport);
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

	private async closeTransport(
		expectedTransport?: DiscordPresenceTransport,
	): Promise<void> {
		const transport = this.transport;
		if (expectedTransport && transport !== expectedTransport) return;
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
	const action = formatAction(record.action, record.phase);
	const context =
		record.context?.percent === null || record.context?.percent === undefined
			? "ctx ?"
			: `ctx ${Math.round(record.context.percent)}%`;
	const breakdown = `in ${formatTokenCount(record.usage.input)} / out ${formatTokenCount(record.usage.output)}`;
	const project = truncateText(record.projectName, 96) || "project";
	return `${project} · ${model} · ${action} · ${formatTokenCount(record.usage.total)} tok (${breakdown}) · ${formatCost(record.usage)} · ${context} · ${formatDuration(now - record.startedAt)}`;
}

export default function (pi: ExtensionAPI) {
	let manager: DiscordPresenceManager | undefined;
	let disabledReason: string | undefined;
	let agentActive = false;
	const activeTools = new Map<string, PresenceAction>();
	let anonymousToolCounter = 0;

	async function handleStatus(
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	) {
		const text = manager
			? await manager.getDiagnosticText()
			: `Discord presence: ${disabledReason ?? "not started"}`;
		ctx.ui.notify(
			text,
			manager?.getStatus() === "connected" ? "info" : "warning",
		);
	}

	async function handlePrivacy(
		arg: string,
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	) {
		let nextMode: PresencePrivacyMode;
		if (arg) {
			if (arg !== "strict" && arg !== "project" && arg !== "developer") {
				ctx.ui.notify(
					`Unknown privacy mode "${arg}". Options: ${PRIVACY_MODES.join(", ")}`,
					"warning",
				);
				return;
			}
			nextMode = arg;
		} else {
			const current = manager?.getPrivacyMode() ?? "strict";
			const currentIndex = PRIVACY_MODES.indexOf(current);
			nextMode = PRIVACY_MODES[(currentIndex + 1) % PRIVACY_MODES.length];
		}

		const prefs = await readPrefs();
		prefs.privacyMode = nextMode;
		await writePrefs(prefs);

		if (manager) {
			await manager.setPrivacyMode(nextMode);
		}

		ctx.ui.notify(
			`Discord Presence privacy mode set to "${nextMode}" (saved).`,
			"info",
		);
	}

	async function handleToggle(
		arg: string,
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	) {
		const prefs = await readPrefs();
		const currentEnabled = prefs.enabled !== false;
		let nextEnabled: boolean;

		if (arg === "on") nextEnabled = true;
		else if (arg === "off") nextEnabled = false;
		else nextEnabled = !currentEnabled;

		prefs.enabled = nextEnabled;
		await writePrefs(prefs);

		if (nextEnabled) {
			if (manager) {
				void manager.start();
				ctx.ui.notify("Discord Presence enabled and running.", "info");
			} else {
				ctx.ui.notify(
					"Discord Presence enabled. Reload or restart session to activate.",
					"info",
				);
			}
		} else {
			if (manager) {
				await manager.stop();
			}
			ctx.ui.notify(
				"Discord Presence disabled (/discord toggle on to resume).",
				"info",
			);
		}
	}

	async function handleConfig(
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	) {
		const prefs = await readPrefs();
		const configuredClientId = process.env[CLIENT_ID_ENV];
		const clientId = configuredClientId ?? DEFAULT_CLIENT_ID;
		const isDefaultClient = clientId === DEFAULT_CLIENT_ID;
		const privacy =
			manager?.getPrivacyMode() ??
			prefs.privacyMode ??
			parsePrivacyMode(process.env[PRIVACY_ENV]);
		const enabled = prefs.enabled !== false;
		const transportMode = resolveDiscordTransportMode();
		const buttonsEnv = process.env[BUTTONS_ENV];
		const buttons =
			buttonsEnv !== "off" &&
			buttonsEnv !== "false" &&
			buttonsEnv !== "none" &&
			buttonsEnv !== "0" &&
			prefs.buttons !== false;

		const largeImg =
			process.env[LARGE_IMAGE_ENV] ??
			prefs.largeImage ??
			(isDefaultClient ? "pi" : "(none)");
		const smallImg =
			process.env[SMALL_IMAGES_ENV] ??
			prefs.smallImages ??
			(isDefaultClient ? "action badge" : "(none)");

		const lines = [
			"Discord Rich Presence Configuration:",
			`• Status: ${manager?.getStatusText() ?? (enabled ? "ready" : "disabled")}`,
			`• Transport: ${transportMode}`,
			`• Privacy Mode: ${privacy}`,
			`• Show Price: yes (by default when pricing is available)`,
			`• Client ID: ${clientId} (${isDefaultClient ? "default" : "custom"})`,
			`• Buttons: ${buttons ? "enabled" : "disabled"}`,
			`• Large Image: ${largeImg}`,
			`• Small Images: ${smallImg}`,
			`• Preferences file: ${DEFAULT_PREFS_PATH}`,
			"",
			"Commands:",
			"• /discord status — view active sessions & diagnostics",
			"• /discord privacy [strict|project|developer] — set privacy mode",
			"• /discord toggle [on|off] — toggle presence on or off",
			"• /discord config — show configuration overview",
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	// Unified /discord command
	pi.registerCommand("discord", {
		description:
			"Manage Discord Rich Presence (/discord status | privacy | toggle | config)",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const spaceIndex = trimmed.indexOf(" ");
			if (spaceIndex === -1) {
				const subcommands = ["status", "privacy", "toggle", "config", "help"];
				const filtered = subcommands.filter((sub) => sub.startsWith(trimmed));
				return filtered.length > 0
					? filtered.map((sub) => ({ value: sub, label: sub }))
					: null;
			}

			const sub = trimmed.slice(0, spaceIndex).toLowerCase();
			const rest = trimmed.slice(spaceIndex + 1).trimStart();

			if (sub === "privacy") {
				const options = ["strict", "project", "developer"];
				const filtered = options.filter((o) => o.startsWith(rest));
				return filtered.length > 0
					? filtered.map((o) => ({
							value: `privacy ${o}`,
							label: `privacy ${o}`,
						}))
					: null;
			}

			if (sub === "toggle") {
				const options = ["on", "off"];
				const filtered = options.filter((o) => o.startsWith(rest));
				return filtered.length > 0
					? filtered.map((o) => ({
							value: `toggle ${o}`,
							label: `toggle ${o}`,
						}))
					: null;
			}

			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const sub = (
				spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
			).toLowerCase();
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

			switch (sub) {
				case "status":
					await handleStatus(ctx);
					break;
				case "privacy":
					await handlePrivacy(rest, ctx);
					break;
				case "toggle":
					await handleToggle(rest, ctx);
					break;
				case "config":
					await handleConfig(ctx);
					break;
				case "help":
				case "":
					await handleConfig(ctx);
					break;
				default:
					ctx.ui.notify(
						`Unknown subcommand "${sub}". Usage: /discord status | privacy | toggle | config`,
						"warning",
					);
					break;
			}
		},
	});

	// Backwards-compatible alias
	pi.registerCommand("discord-status", {
		description: "Show Discord Rich Presence connection and session statistics",
		handler: async (_args, ctx) => handleStatus(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionStartedAt = Date.now();
		if (manager) await manager.stop();
		manager = undefined;
		disabledReason = undefined;
		agentActive = false;
		activeTools.clear();
		anonymousToolCounter = 0;

		const prefs = await readPrefs();
		if (prefs.enabled === false) {
			disabledReason = "disabled via /discord-toggle (preferences)";
			return;
		}

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

		const privacyMode =
			prefs.privacyMode ?? parsePrivacyMode(process.env[PRIVACY_ENV]);
		const showCost =
			process.env[SHOW_COST_ENV] !== "off" &&
			process.env[SHOW_COST_ENV] !== "false" &&
			prefs.showCost !== false;
		const enableButtons =
			process.env[BUTTONS_ENV] !== "off" &&
			process.env[BUTTONS_ENV] !== "false" &&
			process.env[BUTTONS_ENV] !== "0" &&
			prefs.buttons !== false;

		manager = new DiscordPresenceManager({
			clientId,
			projectName,
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			startedAt: sessionStartedAt,
			initialUsage,
			initialContext,
			privacyMode,
			showCost,
			enableButtons,
			largeImageKey: process.env[LARGE_IMAGE_ENV] ?? prefs.largeImage,
			smallImageKey: process.env[SMALL_IMAGES_ENV] ?? prefs.smallImages,
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
		activeTools.clear();
		await manager?.setPhase("thinking", "thinking");
	});

	pi.on("tool_execution_start", async (event) => {
		const action = classifyToolAction(event?.toolName);
		const callId = event?.toolCallId ?? `anon-${++anonymousToolCounter}`;
		activeTools.set(callId, action);
		const currentAction = pickHighestPriorityAction(activeTools.values());
		await manager?.setPhase("tools", currentAction);
	});

	pi.on("tool_execution_end", async (event) => {
		if (event?.toolCallId && activeTools.has(event.toolCallId)) {
			activeTools.delete(event.toolCallId);
		} else if (activeTools.size > 0) {
			const firstKey = activeTools.keys().next().value;
			if (firstKey !== undefined) activeTools.delete(firstKey);
		}

		if (activeTools.size > 0) {
			const currentAction = pickHighestPriorityAction(activeTools.values());
			await manager?.setPhase("tools", currentAction);
		} else if (agentActive) {
			await manager?.setPhase("thinking", "thinking");
		} else {
			await manager?.setPhase("idle", "idle");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		agentActive = false;
		activeTools.clear();
		await manager?.setPhase("idle", "idle");
		await manager?.setContextUsage(normalizeContextUsage(ctx.getContextUsage()));
	});

	pi.on("session_shutdown", async () => {
		await manager?.stop();
		manager = undefined;
	});
}
