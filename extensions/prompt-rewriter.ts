/**
 * Prompt rewriter extension.
 *
 * Rewrites a rough prompt into a precise one *before* it reaches the agent, so
 * the improved prompt is simply the one you send: no extra turn, no injected
 * "here is your rewritten prompt" message, and no rewriting chatter in the
 * conversation.
 *
 * Flows:
 *    - `/rewrite <prompt>` rewrites the given text and loads it into the editor,
 *      so you can review or edit it before pressing Enter.
 *    - `/rewrite last` shows the previous rewrite, or why it was unavailable.
 *
 * Commands:
 *   /rewrite <prompt>                  rewrite the given text
 *   /rewrite model [<provider/id>|reset]  choose the rewrite model
 *   /rewrite context [on|off]          include recent conversation context
 *   /rewrite last                      show the last rewrite
 *   /rewrite help                      show help and current settings
 *   /rewrite                           open the settings menu in the TUI
 *
 * Optional environment settings:
 *   PI_REWRITE_MODEL=provider/id       seed the rewrite model (default: session model)
 *   PI_REWRITE_CONTEXT=on|off          seed context handling (default: on)
 *   PI_REWRITE_THINKING=<level>        minimal|low|medium|high|xhigh|max|default
 *   PI_REWRITE_TIMEOUT_MS=<ms>         rewrite timeout (default: 15000)
 *
 * Saved model/context preferences take precedence over environment values. Files
 * use PI_CODING_AGENT_DIR when set, otherwise ~/.pi/agent.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	agentFilePath,
	argumentCompletions,
	commandHelp,
	loadPrefs,
	parseOnOff,
	parseSubcommand,
	savePrefs,
	showHelp,
	showText,
	type CommandSpec,
} from "./shared/command-kit.ts";
import { asRecord } from "./shared/record-guards.ts";
import { menuSupported, showExtensionMenu } from "./shared/settings-menu.ts";

const PREFS_FILE = "prompt-rewriter-prefs.json";
const STATUS_KEY = "prompt-rewriter";

/** One table drives help, completions, and unknown-subcommand usage. */
export const REWRITE_SPECS: readonly CommandSpec[] = [
	{
		name: "",
		hint: "<prompt>",
		description: "rewrite the prompt and load the result into the editor",
	},
	{
		name: "model",
		hint: "<provider/id>|reset",
		description: "rewrite model (default: session model)",
	},
	{
		name: "context",
		values: ["on", "off"],
		description: "include a short recent-conversation excerpt",
	},
	{ name: "last", description: "show the last rewrite" },
	{ name: "help", description: "show this help" },
];
const DEFAULT_TIMEOUT_MS = 15_000;
const CONTEXT_MESSAGES = 3;
const CONTEXT_CHARS_PER_MESSAGE = 600;
const LIST_TRUNCATE_CHARS = 400;

/** The meta-prompt. Keep the rewrite cheap, faithful, and commentary-free. */
export const REWRITER_SYSTEM_PROMPT = `You rewrite a developer's rough request into a precise prompt for a coding agent that will act on it.

You are a rewriter, not an assistant:
- Do not answer, execute, explain, or comment on the request. Do not describe what you changed.
- Output only the rewritten prompt. No preamble, no labels, no quotes, no wrapping code fence.
- Never ask the user a question; the coding agent can ask if it needs to.
- If the request is already clear, return it nearly unchanged. A small edit is a valid answer.

Preserve faithfully:
- The author's intent, scope, and language.
- Every stated constraint, preference, prohibition, and reason to avoid something.
- Verbatim tokens: file paths, identifiers, commands, flags, URLs, numbers, error text, and all code, fences, and indentation.
- Never invent files, technologies, versions, requirements, or facts the author did not state or clearly imply.

Make it actionable:
- Lead with the concrete goal, in the imperative.
- Keep the place to change when the author named one.
- Keep or add the observable result the work must produce (behavior, test, build).
- Split unrelated asks into a short ordered list; drop repetition and pleasantries.
- Do not add conditions, policies, or alternatives the author did not ask for (no "ask me first", no extra options to choose from).

Length: keep it close to the original, never more than about twice as long.`;

/** Thinking levels accepted by the provider-neutral stream options. */
export type RewriteThinking = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RewritePrefs {
	/** Rewrite model as `provider/modelId`, or null for the session model. */
	model: string | null;
	/** Include a short recent-conversation excerpt to resolve references. */
	context: boolean;
}

export const DEFAULT_PREFS: RewritePrefs = {
	model: null,
	context: true,
};

export const REWRITE_THINKING_LEVELS: readonly RewriteThinking[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export interface RewriteEnv {
	model?: string;
	context?: boolean;
	thinking?: RewriteThinking | "default";
	timeoutMs?: number;
}

type EnvRecord = Record<string, string | undefined>;

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalized)) {
		return true;
	}
	if (["off", "false", "no", "0", "disable", "disabled"].includes(normalized)) {
		return false;
	}
	return undefined;
}

export function normalizeThinking(value: unknown): RewriteThinking | "default" | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "default" || normalized === "off" || normalized === "none") {
		return "default";
	}
	return (REWRITE_THINKING_LEVELS as readonly string[]).includes(normalized)
		? (normalized as RewriteThinking)
		: undefined;
}

export function normalizeTimeout(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return Math.min(120_000, Math.max(1_000, Math.trunc(parsed)));
}

/** Validate a parsed prefs file, falling back to defaults on anything odd. */
export function normalizePrefs(value: unknown): RewritePrefs {
	const record = asRecord(value);
	return {
		model: normalizeModelRef(record?.model) ?? DEFAULT_PREFS.model,
		context: asBoolean(record?.context) ?? DEFAULT_PREFS.context,
	};
}

function normalizeModelRef(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return parseModelRef(trimmed) ? trimmed : undefined;
}

/** Read optional environment defaults and launch-specific tuning. */
export function readEnv(env: EnvRecord): RewriteEnv {
	return {
		model: normalizeModelRef(env.PI_REWRITE_MODEL),
		context: asBoolean(env.PI_REWRITE_CONTEXT),
		thinking: normalizeThinking(env.PI_REWRITE_THINKING) ?? "minimal",
		timeoutMs: normalizeTimeout(env.PI_REWRITE_TIMEOUT_MS),
	};
}

/** Stored settings win; environment values seed settings that have not been saved. */
export function resolvePrefs(fileValue: unknown, env: RewriteEnv): RewritePrefs {
	const record = asRecord(fileValue);
	const prefs = normalizePrefs(fileValue);
	const hasModelPref = Boolean(
		record &&
			Object.hasOwn(record, "model") &&
			(record.model === null || normalizeModelRef(record.model) !== undefined),
	);
	const hasContextPref = typeof record?.context === "boolean";
	return {
		model: hasModelPref ? prefs.model : (env.model ?? prefs.model),
		context: hasContextPref ? prefs.context : (env.context ?? prefs.context),
	};
}

export function parseModelRef(value: string): { provider: string; modelId: string } | undefined {
	const trimmed = value.trim();
	const index = trimmed.indexOf("/");
	if (index <= 0 || index === trimmed.length - 1) {
		return undefined;
	}
	return { provider: trimmed.slice(0, index), modelId: trimmed.slice(index + 1) };
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

const PATH_PATTERN = /\b[\w.@-]+(?:\/[\w.@-]+)+\b/g;
const FLAG_PATTERN = /(?:^|\s)(--?[A-Za-z][\w-]*)/g;
const ENV_PATTERN = /\$\{?[A-Z_][A-Z0-9_]*\}?/g;
const SNAKE_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CAMEL_PATTERN = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g;
const PASCAL_PATTERN = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g;
const FILENAME_PATTERN =
	/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|mts|py|go|rs|java|rb|json|ya?ml|toml|md|css|html|sh|sql)\b/g;
const CONSTANT_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const BACKTICK_PATTERN = /`([^`\n]+)`/g;
const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const FENCE_PATTERN = /```/g;

const NON_PATH_WORDS = new Set(["and/or", "he/she", "she/he", "24/7", "w/o", "n/a"]);

function matchAll(pattern: RegExp, text: string): string[] {
	const matches: string[] = [];
	for (const match of text.matchAll(pattern)) {
		const value = (match[1] ?? match[0]).trim();
		if (value.length >= 2 && !NON_PATH_WORDS.has(value.toLowerCase())) {
			matches.push(value);
		}
	}
	return matches;
}

/** Tokens a rewrite must carry over verbatim. */
export function protectedTokens(text: string): string[] {
	const tokens = [
		...matchAll(URL_PATTERN, text),
		...matchAll(BACKTICK_PATTERN, text),
		...matchAll(PATH_PATTERN, text),
		...matchAll(FILENAME_PATTERN, text),
		...matchAll(FLAG_PATTERN, text),
		...matchAll(ENV_PATTERN, text),
		...matchAll(SNAKE_PATTERN, text),
		...matchAll(CAMEL_PATTERN, text),
		...matchAll(PASCAL_PATTERN, text),
		...matchAll(CONSTANT_PATTERN, text),
	];
	const unique = [...new Set(tokens)];
	// Drop nested tokens ("a.ts" inside "src/a.ts") so reports name the longest form.
	return unique.filter(
		(token) => !unique.some((other) => other !== token && other.includes(token)),
	);
}

export function missingProtectedTokens(original: string, candidate: string): string[] {
	return protectedTokens(original).filter((token) => !candidate.includes(token));
}

function countFences(text: string): number {
	return (text.match(FENCE_PATTERN) ?? []).length;
}

function stripWrappingFence(text: string): string {
	const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
	if (!match) {
		return text;
	}
	const inner = match[1] ?? "";
	return inner.includes("```") ? text : inner;
}

const LEADING_LABEL =
	/^(?:#{1,6}\s*)?(?:\*\*)?(?:rewritten|improved|enhanced|revised|clarified|updated)\s*(?:prompt|request|version)?(?:\*\*)?\s*[:\-\u2013\u2014]\s*/i;
const LEADING_SENTENCE =
	/^(?:sure[,!.]?\s*)?here(?:'s| is) the (?:rewritten|improved|enhanced|revised) (?:prompt|request|version)\b[^\n]*:\s*/i;

function stripLeadingLabel(text: string): string {
	const withoutSentence = text.replace(LEADING_SENTENCE, "");
	const firstLineEnd = withoutSentence.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? withoutSentence : withoutSentence.slice(0, firstLineEnd);
	if (firstLine.length > 80) {
		return withoutSentence;
	}
	if (!LEADING_LABEL.test(firstLine)) {
		return withoutSentence;
	}
	return (
		firstLine.replace(LEADING_LABEL, "") +
		(firstLineEnd === -1 ? "" : withoutSentence.slice(firstLineEnd))
	);
}

const ASSISTANT_VOICE =
	/^(?:sure|certainly|of course|no problem|got it|understood|here(?:'s| is)|i(?:'ll| will| can| have| would)|let me)\b/i;

export type SanitizeOutcome =
	| { ok: true; text: string; changed: boolean }
	| { ok: false; reason: string };

export interface SanitizeOptions {
	maxGrowthRatio?: number;
	minShrinkRatio?: number;
}

/**
 * Validate model output before it replaces the user's prompt.
 *
 * Rejecting is always safe: the caller falls back to the original text.
 */
export function sanitizeRewrite(
	original: string,
	raw: string,
	options: SanitizeOptions = {},
): SanitizeOutcome {
	const source = original.replace(/\r\n?/g, "\n").trim();
	let text = raw.replace(/\r\n?/g, "\n").trim();
	if (text.length === 0) {
		return { ok: false, reason: "empty output" };
	}
	text = stripLeadingLabel(stripWrappingFence(text)).trim();
	if (text.length === 0) {
		return { ok: false, reason: "empty output" };
	}
	if (countFences(text) !== countFences(source)) {
		return { ok: false, reason: "code fences do not match" };
	}
	const missing = missingProtectedTokens(source, text);
	if (missing.length > 0) {
		return { ok: false, reason: `dropped ${missing.slice(0, 3).join(", ")}` };
	}
	const maxGrowth = options.maxGrowthRatio ?? 3;
	if (text.length > Math.max(400, source.length * maxGrowth)) {
		return { ok: false, reason: "grew too much" };
	}
	const minShrink = options.minShrinkRatio ?? 0.34;
	if (source.length >= 160 && text.length < source.length * minShrink) {
		return { ok: false, reason: "lost content" };
	}
	if (ASSISTANT_VOICE.test(text) && !ASSISTANT_VOICE.test(source)) {
		return { ok: false, reason: "answered instead of rewriting" };
	}
	return { ok: true, text, changed: text !== source };
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface ContextExcerptOptions {
	maxMessages?: number;
	maxCharsPerMessage?: number;
}

function messageText(message: unknown): string | undefined {
	const record = asRecord(message);
	if (!record) {
		return undefined;
	}
	const content = record.content;
	if (typeof content === "string") {
		return content.trim() || undefined;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const part of content) {
		const block = asRecord(part);
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	const text = parts.join("\n").trim();
	return text.length > 0 ? text : undefined;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars).trimEnd()}…`;
}

/** A short tail of the conversation, used only to resolve references like "it". */
export function excerptRecentContext(
	entries: readonly unknown[],
	options: ContextExcerptOptions = {},
): string | undefined {
	const maxMessages = options.maxMessages ?? CONTEXT_MESSAGES;
	const maxChars = options.maxCharsPerMessage ?? CONTEXT_CHARS_PER_MESSAGE;
	const lines: string[] = [];
	for (let index = entries.length - 1; index >= 0 && lines.length < maxMessages; index -= 1) {
		const entry = asRecord(entries[index]);
		if (entry?.type !== "message") {
			continue;
		}
		const message = asRecord(entry.message);
		const role = message?.role;
		if (role !== "user" && role !== "assistant") {
			continue;
		}
		const text = messageText(message);
		if (!text) {
			continue;
		}
		const label = role === "user" ? "User" : "Assistant";
		lines.push(`${label}: ${truncate(text, maxChars)}`);
	}
	if (lines.length === 0) {
		return undefined;
	}
	return lines.reverse().join("\n\n");
}

export interface UserContentOptions {
	context?: string;
}

export function buildUserContent(original: string, options: UserContentOptions = {}): string {
	const blocks: string[] = [];
	if (options.context) {
		blocks.push(
			[
				"<recent_conversation>",
				options.context,
				"</recent_conversation>",
				"The excerpt is context only: use it to resolve references in the request. Do not rewrite it.",
			].join("\n"),
		);
	}
	blocks.push(["<request>", original.replace(/\r\n?/g, "\n").trim(), "</request>"].join("\n"));
	return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Rewrite call
// ---------------------------------------------------------------------------

export type RewriteStatus = "rewritten" | "unchanged" | "unavailable";

export interface RewriteOutcome {
	status: RewriteStatus;
	/** Original text whenever the rewrite did not happen. */
	text: string;
	/** Why the rewrite was unavailable, when it was. */
	reason?: string;
}

type ModelLike = NonNullable<ExtensionContext["model"]>;

/** Structural view of an assistant message; avoids depending on pi-ai types. */
interface MessageLike {
	stopReason?: string;
	errorMessage?: string;
	content: readonly unknown[];
}

/**
 * The pinned dev dependency (0.84) predates `ModelRegistry.streamSimple`, while
 * current Pi exposes it. Use it when present and fall back to `complete`.
 */
interface RewriteRegistryBridge {
	streamSimple?(
		model: ModelLike,
		context: unknown,
		options?: Record<string, unknown>,
	): { result(): Promise<MessageLike> };
	complete?(
		model: ModelLike,
		context: unknown,
		options?: Record<string, unknown>,
	): Promise<MessageLike>;
}

function registryBridge(ctx: ExtensionContext): RewriteRegistryBridge {
	return ctx.modelRegistry as unknown as RewriteRegistryBridge;
}

export interface ResolvedModel {
	model?: ModelLike;
	error?: string;
}

export function resolveRewriteModel(ctx: ExtensionContext, prefs: RewritePrefs): ResolvedModel {
	if (prefs.model) {
		const ref = parseModelRef(prefs.model);
		if (!ref) {
			return { error: `invalid model "${prefs.model}" (expected provider/model)` };
		}
		const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
		if (!found) {
			return { error: `model ${prefs.model} not found` };
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
			return { error: `no credentials for ${prefs.model}` };
		}
		return { model: found };
	}
	const model = ctx.model;
	if (!model) {
		return { error: "no model selected" };
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return { error: `no credentials for ${model.provider}/${model.id}` };
	}
	return { model };
}

export interface RewriteOptions {
	ctx: ExtensionContext;
	prefs: RewritePrefs;
	text: string;
	context?: string | undefined;
	thinking?: RewriteThinking | "default" | undefined;
	timeoutMs?: number;
	/** Cancels the rewrite (e.g. Esc in the TUI); reported as "cancelled". */
	signal?: AbortSignal;
}

function assistantText(message: { content: readonly unknown[] }): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => {
			const block = asRecord(part);
			return block?.type === "text" && typeof block.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Rewrite one prompt. Never throws; failures degrade to the original text. */
export async function rewritePrompt(options: RewriteOptions): Promise<RewriteOutcome> {
	const original = options.text;
	const trimmed = original.replace(/\r\n?/g, "\n").trim();
	if (trimmed.length === 0) {
		return { status: "unavailable", text: original, reason: "nothing to rewrite" };
	}
	const resolved = resolveRewriteModel(options.ctx, options.prefs);
	if (!resolved.model) {
		return { status: "unavailable", text: original, reason: resolved.error ?? "no model" };
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const cancel = (): void => controller.abort();
	if (options.signal?.aborted) {
		controller.abort();
	} else {
		options.signal?.addEventListener("abort", cancel, { once: true });
	}

	const reasoning =
		options.thinking && options.thinking !== "default" ? options.thinking : undefined;
	const bridge = registryBridge(options.ctx);
	const baseOptions: Record<string, unknown> = {
		signal: controller.signal,
		maxTokens: Math.min(2400, Math.max(512, Math.ceil(trimmed.length / 3) + 512)),
		cacheRetention: "none",
		sessionId: randomUUID(),
	};
	const context = {
		systemPrompt: REWRITER_SYSTEM_PROMPT,
		messages: [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: buildUserContent(trimmed, {
							context: options.context,
						}),
					},
				],
				timestamp: Date.now(),
			},
		],
	};
	const useStream = typeof bridge.streamSimple === "function";
	if (!useStream && typeof bridge.complete !== "function") {
		return { status: "unavailable", text: original, reason: "model registry cannot run requests" };
	}

	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<undefined>((resolve) => {
		timeoutTimer = setTimeout(() => resolve(undefined), timeoutMs + 1_000);
		timeoutTimer.unref?.();
		// A cancel must not wait on a provider that ignores the abort signal.
		options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
	});

	try {
		const pending = useStream
			? bridge.streamSimple!(
					resolved.model,
					context,
					reasoning ? { ...baseOptions, reasoning } : baseOptions,
				).result()
			: bridge.complete!(resolved.model, context, baseOptions);
		const message = await Promise.race([pending, timeoutPromise]);
		if (!message) {
			controller.abort();
			return {
				status: "unavailable",
				text: original,
				reason: options.signal?.aborted && !timedOut ? "cancelled" : "timed out",
			};
		}
		if (message.stopReason === "aborted") {
			return {
				status: "unavailable",
				text: original,
				reason: timedOut ? "timed out" : "cancelled",
			};
		}
		if (message.stopReason !== "stop") {
			return {
				status: "unavailable",
				text: original,
				reason: message.errorMessage ?? `model stopped: ${message.stopReason}`,
			};
		}
		const sanitized = sanitizeRewrite(trimmed, assistantText(message));
		if (!sanitized.ok) {
			return { status: "unavailable", text: original, reason: sanitized.reason };
		}
		return sanitized.changed
			? { status: "rewritten", text: sanitized.text }
			: { status: "unchanged", text: original };
	} catch (error) {
		return {
			status: "unavailable",
			text: original,
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
		if (timeoutTimer !== undefined) {
			clearTimeout(timeoutTimer);
		}
	}
}

// ---------------------------------------------------------------------------
// Command parsing and formatting
// ---------------------------------------------------------------------------

export type RewriteAction =
	| { action: "improve"; text: string }
	| { action: "model"; value: string | undefined }
	| { action: "context"; value: boolean | undefined }
	| { action: "last" }
	| { action: "help" };

/**
 * Split `/rewrite` arguments into a subcommand or a prompt.
 *
 * A prompt may begin with a subcommand word ("help me fix…", "context menu is
 * broken", "model the user table…"), and Pi has already cleared the editor, so
 * misreading it loses the prompt. A word is a subcommand only when what follows
 * has that subcommand's shape; anything else is a prompt.
 */
export function parseRewriteArgs(args: string): RewriteAction {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { action: "improve", text: "" };
	}
	const { sub, rest } = parseSubcommand(trimmed);
	if ((sub === "help" || sub === "?") && rest.length === 0) {
		return { action: "help" };
	}
	if (sub === "last" && rest.length === 0) {
		return { action: "last" };
	}
	// `model <provider/id>|reset` takes exactly one word; a sentence is a prompt.
	if (sub === "model" && !/\s/.test(rest)) {
		if (rest.length === 0) {
			return { action: "model", value: undefined };
		}
		return { action: "model", value: rest.toLowerCase() === "reset" ? "reset" : rest };
	}
	if (sub === "context") {
		if (rest.length === 0) {
			return { action: "context", value: undefined };
		}
		const value = parseOnOff(rest);
		if (value !== undefined) {
			return { action: "context", value };
		}
	}
	return { action: "improve", text: trimmed };
}

export interface LastOutcome {
	kind: "rewritten" | "unchanged" | "unavailable";
	original: string;
	text?: string;
	reason?: string;
	at: number;
}

export function formatLastRewrite(last: LastOutcome | undefined): string {
	if (!last) {
		return "No prompt rewrite yet.";
	}
	const when = new Date(last.at).toISOString().replace("T", " ").slice(0, 19);
	const lines = [`${last.kind} · ${when} UTC`];
	lines.push("", "Original:", truncate(last.original, LIST_TRUNCATE_CHARS));
	if (last.text !== undefined) {
		lines.push("", "Rewritten:", truncate(last.text, LIST_TRUNCATE_CHARS));
	}
	if (last.reason) {
		lines.push("", `Reason: ${last.reason}`);
	}
	return lines.join("\n");
}

export function formatHelp(prefs: RewritePrefs, env: RewriteEnv): string {
	return commandHelp({
		title: "Prompt rewriter",
		command: "/rewrite",
		specs: REWRITE_SPECS,
		sections: [
			{
				heading: "Settings",
				lines: [
					`model: ${prefs.model ?? "session model"}`,
					`context: ${prefs.context ? "on" : "off"}`,
					`thinking: ${env.thinking ?? "minimal"}`,
					`timeout: ${env.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
				],
			},
		],
	});
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function notify(ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.notify(message, type);
}

function canEdit(ctx: ExtensionContext): boolean {
	return ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");
}

/** Run one rewrite with a transient footer line as its progress indicator. */
async function runWithStatus(
	state: RewriterState,
	ctx: ExtensionContext,
	text: string,
): Promise<RewriteOutcome> {
	const controller = new AbortController();
	let stopListening: (() => void) | undefined;
	if (ctx.mode === "tui") {
		// Esc cancels the rewrite; every other key passes through untouched.
		stopListening = ctx.ui.onTerminalInput((data) => {
			if (data !== ESCAPE || controller.signal.aborted) return undefined;
			controller.abort();
			return { consume: true };
		});
	}
	if (ctx.hasUI) {
		ctx.ui.setStatus(
			STATUS_KEY,
			stopListening ? "✦ rewriting prompt… (Esc to cancel)" : "✦ rewriting prompt…",
		);
	}
	try {
		return await runRewrite(state, ctx, text, controller.signal);
	} finally {
		stopListening?.();
		clearTransientStatus(ctx);
	}
}

const ESCAPE = "\x1b";

interface RewriterState {
	env: RewriteEnv;
	prefs: RewritePrefs | undefined;
	last: LastOutcome | undefined;
	/** True while a rewrite runs; a second /rewrite is refused, not queued. */
	busy: boolean;
}

function createState(env: RewriteEnv): RewriterState {
	return {
		env,
		prefs: undefined,
		last: undefined,
		busy: false,
	};
}

function currentPrefs(state: RewriterState): RewritePrefs {
	state.prefs ??= loadPrefs(PREFS_FILE, (value) => resolvePrefs(value, state.env));
	return state.prefs;
}

function clearTransientStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function contextFor(state: RewriterState, ctx: ExtensionContext): string | undefined {
	if (!currentPrefs(state).context) {
		return undefined;
	}
	try {
		return excerptRecentContext(ctx.sessionManager.getBranch());
	} catch (error) {
		console.error("[prompt-rewriter] failed to read conversation context:", error);
		return undefined;
	}
}

async function runRewrite(
	state: RewriterState,
	ctx: ExtensionContext,
	text: string,
	signal?: AbortSignal,
): Promise<RewriteOutcome> {
	const prefs = currentPrefs(state);
	const outcome = await rewritePrompt({
		ctx,
		prefs,
		text,
		context: contextFor(state, ctx),
		thinking: state.env.thinking,
		timeoutMs: state.env.timeoutMs,
		signal,
	});
	state.last = {
		kind: outcome.status,
		original: text,
		text:
			outcome.status === "rewritten"
				? outcome.text
				: outcome.status === "unchanged"
					? outcome.text
					: undefined,
		reason: outcome.reason,
		at: Date.now(),
	};
	return outcome;
}

/** Improve a draft and put the result back into the editor for review. */
async function improveDraft(
	state: RewriterState,
	ctx: ExtensionContext,
	text: string,
): Promise<void> {
	if (!canEdit(ctx)) {
		console.error("[prompt-rewriter] /rewrite requires TUI or RPC mode to review the result.");
		return;
	}
	if (state.busy) {
		// The draft would otherwise be lost: Pi already cleared the editor.
		ctx.ui.setEditorText(text);
		notify(ctx, "A rewrite is already running — your draft is back in the editor.", "warning");
		return;
	}
	state.busy = true;
	let outcome: RewriteOutcome;
	try {
		outcome = await runWithStatus(state, ctx, text);
	} finally {
		state.busy = false;
	}
	if (outcome.status === "rewritten") {
		ctx.ui.setEditorText(outcome.text);
		notify(ctx, "Prompt improved — review it and press Enter to send.", "info");
		return;
	}
	if (outcome.status === "unchanged") {
		ctx.ui.setEditorText(text);
		notify(ctx, "Prompt is already clear — left unchanged in the editor.", "info");
		return;
	}
	// Give the draft back: Pi cleared the editor before the command ran.
	ctx.ui.setEditorText(text);
	if (outcome.reason === "cancelled") {
		notify(ctx, "Rewrite cancelled — your draft is back in the editor.", "info");
		return;
	}
	notify(
		ctx,
		`Rewrite unavailable: ${outcome.reason ?? "unknown reason"}. Your draft is back in the editor.`,
		"warning",
	);
}

/** State projected onto the bare-`/rewrite` menu screens. */
interface RewriteMenuState {
	model: string | null;
	context: boolean;
	thinking: string;
	timeout: string;
	last: string;
	models: Array<{ id: string; label: string; description: string }>;
}

/** Bare `/rewrite`: the /goal-style menu with the rewrite settings. */
async function showRewriteMenu(state: RewriterState, ctx: ExtensionCommandContext): Promise<void> {
	type Screen = "main" | "settings" | "model" | "last";
	type Action = "open-model" | "set-model" | "set-context";
	await showExtensionMenu<RewriteMenuState, Screen, Action>(
		ctx,
		(kit) =>
			kit.defineMenu<RewriteMenuState, Screen, Action>({
				start: "main",
				screens: {
					main: ({ state: menu }) => ({
						kind: "actions",
						title: "Prompt rewriter",
						lines: [
							`Model: ${menu.model ?? "session model"}`,
							`Context: ${menu.context ? "on" : "off"}`,
							`Thinking: ${menu.thinking} (environment)`,
							`Timeout: ${menu.timeout} (environment)`,
						],
						items: [
							{
								id: "model",
								label: "Rewrite model",
								description: menu.model ?? "session model",
								to: "model",
							},
							{ id: "last", label: "Last rewrite", to: "last" },
							{ id: "settings", label: "Settings", to: "settings" },
							{ id: "close", label: "Close", close: true },
						],
						hint: "close",
					}),
					settings: ({ state: menu }) => ({
						kind: "settings",
						title: "Prompt rewriter settings",
						lines: [
							`Preferences · ${agentFilePath(PREFS_FILE)}`,
							"Thinking and timeout come from the environment.",
						],
						items: [
							{
								id: "model",
								label: "Rewrite model",
								description: "Model used to rewrite prompts before sending.",
								currentValue: menu.model ?? "session model",
								action: "open-model",
							},
							{
								id: "context",
								label: "Conversation context",
								description: "Include a short recent-conversation excerpt to resolve references.",
								currentValue: menu.context ? "On" : "Off",
								values: ["On", "Off"],
								action: "set-context",
							},
						],
					}),
					model: ({ state: menu }) => ({
						kind: "choice",
						title: "Rewrite model",
						lines: ["The rewriter uses this model; the session model is the default."],
						items: [
							{
								id: "session",
								label: "Session model",
								description: "Use whatever model this session runs (default)",
							},
							...menu.models,
						],
						currentItemId: menu.model ?? "session",
						enableSearch: true,
						action: "set-model",
						hint: "back",
					}),
					last: ({ state: menu }) => ({
						kind: "detail",
						title: "Prompt rewriter — last rewrite",
						lines: menu.last.split("\n"),
						hint: "back",
					}),
				},
				actions: {
					"open-model": () => ({ kind: "to", screen: "model" }),
					"set-model": async ({ itemId, ctx: menuCtx }) => {
						if (itemId === "session") {
							state.prefs = { ...currentPrefs(state), model: null };
							await savePrefs(PREFS_FILE, state.prefs, "[prompt-rewriter]");
							notify(menuCtx, "Rewrite model reset to the session model.", "info");
							return { kind: "back" };
						}
						const ref = parseModelRef(itemId);
						if (!ref) {
							notify(menuCtx, `Invalid model "${itemId}" — expected provider/model.`, "warning");
							return { kind: "rejected" };
						}
						state.prefs = { ...currentPrefs(state), model: `${ref.provider}/${ref.modelId}` };
						await savePrefs(PREFS_FILE, state.prefs, "[prompt-rewriter]");
						notify(menuCtx, `Rewrite model set to ${itemId}.`, "info");
						return { kind: "back" };
					},
					"set-context": async ({ value, ctx: menuCtx }) => {
						const next = value !== "Off";
						state.prefs = { ...currentPrefs(state), context: next };
						await savePrefs(PREFS_FILE, state.prefs, "[prompt-rewriter]");
						notify(menuCtx, `Rewrite context ${next ? "on" : "off"}.`, "info");
						return { kind: "stay" };
					},
				},
			}),
		{
			getState: (menuCtx) => ({
				model: currentPrefs(state).model,
				context: currentPrefs(state).context,
				thinking: state.env.thinking ?? "minimal",
				timeout: `${state.env.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
				last: formatLastRewrite(state.last),
				models: menuCtx.modelRegistry.getAvailable().map((model) => ({
					id: `${model.provider}/${model.id}`,
					label: `${model.provider}/${model.id}`,
					description: model.name,
				})),
			}),
		},
	);
}

export default function promptRewriter(pi: ExtensionAPI): void {
	const state = createState(readEnv(process.env));

	pi.on("session_start", () => {
		state.prefs = loadPrefs(PREFS_FILE, (value) => resolvePrefs(value, state.env));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearTransientStatus(ctx);
	});

	pi.registerCommand("rewrite", {
		description: "Rewrite a prompt before sending it (/rewrite help)",
		getArgumentCompletions: (prefix) => argumentCompletions(REWRITE_SPECS, prefix),
		handler: async (args, ctx) => {
			await runRewriteCommand(state, args, ctx);
		},
	});
}

async function runRewriteCommand(
	state: RewriterState,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parsed = parseRewriteArgs(args);
	switch (parsed.action) {
		case "help": {
			await showHelp(ctx, formatHelp(currentPrefs(state), state.env));
			return;
		}
		case "last": {
			await showText(ctx, "Prompt rewriter — last", formatLastRewrite(state.last));
			return;
		}
		case "context": {
			const next = parsed.value ?? !currentPrefs(state).context;
			state.prefs = { ...currentPrefs(state), context: next };
			await savePrefs(PREFS_FILE, state.prefs, "[prompt-rewriter]");
			notify(ctx, `Rewrite context ${next ? "on" : "off"}.`, "info");
			return;
		}
		case "model": {
			if (parsed.value === undefined) {
				notify(ctx, `Rewrite model: ${currentPrefs(state).model ?? "session model"}.`, "info");
				return;
			}
			if (parsed.value === "reset") {
				state.prefs = { ...currentPrefs(state), model: null };
				await savePrefs(PREFS_FILE, state.prefs, "[prompt-rewriter]");
				notify(ctx, "Rewrite model reset to the session model.", "info");
				return;
			}
			const ref = parseModelRef(parsed.value);
			if (!ref) {
				notify(ctx, `Invalid model "${parsed.value}" — expected provider/model.`, "warning");
				return;
			}
			const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
			if (!found) {
				notify(ctx, `Model ${parsed.value} not found.`, "warning");
				return;
			}
			state.prefs = { ...currentPrefs(state), model: `${ref.provider}/${ref.modelId}` };
			await savePrefs(PREFS_FILE, state.prefs, "[prompt-rewriter]");
			notify(ctx, `Rewrite model set to ${parsed.value}.`, "info");
			return;
		}
		case "improve": {
			if (parsed.text.length === 0) {
				if (menuSupported(ctx)) {
					await showRewriteMenu(state, ctx);
					return;
				}
				notify(ctx, "Nothing to rewrite — pass the prompt: /rewrite <prompt>", "info");
				return;
			}
			await improveDraft(state, ctx, parsed.text);
			return;
		}
	}
}
