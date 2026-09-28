import assert from "node:assert/strict";
import fs from "node:fs";
import test, { type TestContext } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import promptRewriter, {
	buildUserContent,
	excerptRecentContext,
	formatHelp,
	formatLastRewrite,
	missingProtectedTokens,
	normalizePrefs,
	normalizeThinking,
	normalizeTimeout,
	parseModelRef,
	parseRewriteArgs,
	protectedTokens,
	readEnv,
	resolvePrefs,
	REWRITER_SYSTEM_PROMPT,
	sanitizeRewrite,
} from "../extensions/prompt-rewriter.ts";

const START = 1_800_000_000_000;

const REWRITE_ENV_KEYS = [
	"PI_REWRITE_MODEL",
	"PI_REWRITE_CONTEXT",
	"PI_REWRITE_THINKING",
	"PI_REWRITE_TIMEOUT_MS",
] as const;

interface HarnessOptions {
	/** Raw prefs file body; used to exercise malformed JSON. */
	rawPrefs?: string;
	env?: Record<string, string | undefined>;
	branch?: unknown[];
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	findModel?: boolean;
	hasAuth?: boolean;
	streamApi?: "streamSimple" | "complete" | "none";
	/** What the rewrite model replies with, or a function of the request. */
	reply?: string | ((request: string) => string);
	/** Override the whole model call, e.g. to hang or fail. */
	streamResult?: () => Promise<unknown>;
}

/**
 * Harness around the extension's registered events and command.
 * fs is mocked so prefs never touch the real ~/.pi/agent directory.
 */
function harness(t: TestContext, options: HarnessOptions = {}) {
	const savedEnv = new Map<string, string | undefined>();
	for (const key of [...REWRITE_ENV_KEYS, ...Object.keys(options.env ?? {})]) {
		if (savedEnv.has(key)) {
			continue;
		}
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (value !== undefined) {
			process.env[key] = value;
		}
	}
	t.after(() => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	const errors: string[] = [];
	t.mock.method(console, "error", (message: unknown) => {
		errors.push(String(message));
	});
	t.mock.method(fs, "readFileSync", () => options.rawPrefs ?? JSON.stringify({}));
	t.mock.method(fs.promises, "mkdir", async () => undefined);
	// Emulate the fs so atomic prefs writes land where the assertions expect them.
	const files = new Map<string, string>();
	let prefSaves = 0;
	t.mock.method(fs.promises, "writeFile", async (filePath: unknown, data: unknown) => {
		files.set(String(filePath), String(data));
	});
	t.mock.method(fs.promises, "rename", async (from: unknown, to: unknown) => {
		const data = files.get(String(from));
		if (data === undefined) {
			throw new Error("ENOENT");
		}
		files.delete(String(from));
		files.set(String(to), data);
		prefSaves += 1;
	});
	t.mock.method(fs.promises, "unlink", async (filePath: unknown) => {
		files.delete(String(filePath));
	});
	const prefsEntries = (): Array<{ path: string; data: string }> =>
		[...files]
			.filter(([filePath]) => filePath.endsWith("prompt-rewriter-prefs.json"))
			.map(([filePath, data]) => ({ path: filePath, data }));

	const requests: Array<{ systemPrompt: unknown; userText: string; options: Record<string, unknown> }> = [];
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ text: string; level: string | undefined }> = [];
	const editorWrites: string[] = [];
	const editors: Array<{ title: string; prefill: string }> = [];
	let editorText = "";

	const replyText = (userText: string): string => {
		// The model sees the wrapped request; a test reply normally wants just the prompt.
		const request = extractRequestBlock(userText) || userText;
		if (typeof options.reply === "function") {
			return options.reply(request);
		}
		return options.reply ?? `Improve the auth flow: ${request}`;
	};
	const callModel = (
		context: { systemPrompt?: string; messages?: unknown[] },
		streamOptions: Record<string, unknown>,
	) => {
		const userText = extractRequestText(context.messages);
		requests.push({ systemPrompt: context.systemPrompt, userText, options: streamOptions });
		if (options.streamResult) {
			return options.streamResult();
		}
		return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: replyText(userText) }] });
	};

	const registry: Record<string, unknown> = {
		find: (provider: string, modelId: string) =>
			options.findModel === false ? undefined : { provider, id: modelId },
		hasConfiguredAuth: () => options.hasAuth ?? true,
	};
	if (options.streamApi !== "complete" && options.streamApi !== "none") {
		registry.streamSimple = (_model: unknown, context: never, streamOptions: never) => ({
			result: () => callModel(context, streamOptions),
		});
	}
	if (options.streamApi !== "streamSimple" && options.streamApi !== "none") {
		registry.complete = (_model: unknown, context: never, streamOptions: never) =>
			callModel(context, streamOptions);
	}

	const inputHandlers = new Set<(data: string) => { consume?: boolean } | undefined>();
	const ctx = {
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		cwd: "/tmp/project",
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		modelRegistry: registry,
		sessionManager: { getBranch: () => options.branch ?? [] },
		isIdle: () => true,
		signal: undefined,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
			notify: (text: string, level?: string) => {
				notifications.push({ text, level });
			},
			setEditorText: (text: string) => {
				editorWrites.push(text);
				editorText = text;
			},
			getEditorText: () => editorText,
			onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
				inputHandlers.add(handler);
				return () => inputHandlers.delete(handler);
			},
			editor: async (title: string, prefill: string) => {
				editors.push({ title, prefill });
				return undefined;
			},
		},
	} as unknown as ExtensionCommandContext;

	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<
		string,
		{ description?: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }
	>();

	promptRewriter({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			events.set(name, handler);
		},
		registerCommand: (
			name: string,
			command: { description?: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> },
		) => {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI);

	events.get("session_start")?.({}, ctx);

	return {
		ctx,
		statuses,
		errors,
		notifications,
		editorWrites,
		editors,
		get prefWrites() {
			return prefsEntries();
		},
		get prefSaves() {
			return prefSaves;
		},
		requests,
		events,
		commands,
		setEditorText(text: string) {
			editorText = text;
		},
		/** Simulate raw terminal input; returns whether a listener consumed it. */
		press(data: string): boolean {
			let consumed = false;
			for (const handler of [...inputHandlers]) {
				if (handler(data)?.consume) consumed = true;
			}
			return consumed;
		},
		get inputListeners() {
			return inputHandlers.size;
		},
		getEditorText() {
			return editorText;
		},
		async fire(name: string, event: unknown = {}): Promise<unknown> {
			const handler = events.get(name);
			assert.ok(handler, `no handler registered for ${name}`);
			return await handler(event, ctx);
		},
		async command(args: string): Promise<void> {
			const entry = commands.get("rewrite");
			assert.ok(entry, "rewrite command not registered");
			await entry.handler(args, ctx);
		},
		lastNotification(): { text: string; level: string | undefined } {
			const last = notifications.at(-1);
			assert.ok(last, "no notification recorded");
			return last;
		},
		savedPrefs(): Record<string, unknown> {
			const last = prefsEntries().at(-1);
			assert.ok(last, "no prefs write recorded");
			return JSON.parse(String(last.data)) as Record<string, unknown>;
		},
	};
}

function extractRequestText(messages: unknown[] | undefined): string {
	const first = messages?.[0] as { content?: Array<{ text?: string }> } | undefined;
	return first?.content?.[0]?.text ?? "";
}

function extractRequestBlock(userText: string): string {
	return /<request>\n([\s\S]*?)\n<\/request>/.exec(userText)?.[1] ?? "";
}

const ROUGH_PROMPT = "make the auth flow better";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("normalizePrefs falls back to defaults and validates what it reads", () => {
	assert.deepEqual(normalizePrefs(undefined), { model: null, context: true });
	assert.deepEqual(normalizePrefs({ model: "openai/gpt-5.2", context: false }), {
		model: "openai/gpt-5.2",
		context: false,
	});
	// Bad values are dropped, never trusted.
	assert.deepEqual(normalizePrefs({ model: "not-a-ref", context: 3 }), { model: null, context: true });
	assert.deepEqual(normalizePrefs("nope"), { model: null, context: true });
});

test("stored settings win; env values seed unset settings", () => {
	const env = readEnv({
		PI_REWRITE_MODEL: "openai/gpt-5.2-mini",
		PI_REWRITE_CONTEXT: "0",
		PI_REWRITE_THINKING: "low",
		PI_REWRITE_TIMEOUT_MS: "5000",
	});
	assert.deepEqual(resolvePrefs({ model: null, context: true }, env), {
		model: null,
		context: true,
	});
	assert.deepEqual(resolvePrefs({}, env), {
		model: "openai/gpt-5.2-mini",
		context: false,
	});
	assert.deepEqual(resolvePrefs({ model: "anthropic/claude-sonnet", context: false }, env), {
		model: "anthropic/claude-sonnet",
		context: false,
	});
	assert.equal(env.thinking, "low");
	assert.equal(env.timeoutMs, 5000);
	assert.equal(readEnv({}).model, undefined);
});

test("env parsers reject junk", () => {
	assert.equal(normalizeThinking("MINIMAL"), "minimal");
	assert.equal(normalizeThinking("off"), "default");
	assert.equal(normalizeThinking("extreme"), undefined);
	assert.equal(normalizeTimeout("250"), 1000);
	assert.equal(normalizeTimeout("0"), undefined);
	assert.equal(normalizeTimeout("nope"), undefined);
	assert.equal(readEnv({}).thinking, "minimal");
});

test("parseModelRef splits provider and model only once", () => {
	assert.deepEqual(parseModelRef("openai/gpt-5.2"), { provider: "openai", modelId: "gpt-5.2" });
	assert.deepEqual(parseModelRef("openrouter/anthropic/claude"), {
		provider: "openrouter",
		modelId: "anthropic/claude",
	});
	assert.equal(parseModelRef("gpt-5.2"), undefined);
	assert.equal(parseModelRef("/model"), undefined);
	assert.equal(parseModelRef("provider/"), undefined);
});

test("protected tokens cover the things a rewrite must not touch", () => {
	const tokens = protectedTokens(
		"fix `parseRewriteArgs` in src/core/model-registry.ts, run `npm test -- --watch`, set PI_REWRITE_TIMEOUT_MS=5000, and check readThroughput in BadgeState",
	);
	assert.ok(tokens.includes("parseRewriteArgs"));
	assert.ok(tokens.includes("src/core/model-registry.ts"));
	assert.ok(tokens.includes("npm test -- --watch"));
	assert.ok(tokens.includes("PI_REWRITE_TIMEOUT_MS"));
	assert.ok(tokens.includes("readThroughput"));
	assert.ok(tokens.includes("BadgeState"));
	assert.equal(protectedTokens("either/or and/or he/she").includes("and/or"), false);
	assert.deepEqual(missingProtectedTokens("edit src/a.ts", "edit src/b.ts"), ["src/a.ts"]);
	assert.deepEqual(missingProtectedTokens("edit src/a.ts", "edit src/a.ts now"), []);
});

test("sanitizeRewrite strips wrappers and rejects unsafe output", () => {
	const wrapped = sanitizeRewrite("make it better", "```\nImprove the button contrast in src/button.ts.\n```");
	assert.equal(wrapped.ok, true);
	assert.equal(wrapped.ok && wrapped.text, "Improve the button contrast in src/button.ts.");

	const labelled = sanitizeRewrite("make it better", "Rewritten prompt: Improve the button contrast.");
	assert.equal(labelled.ok, true);
	assert.equal(labelled.ok && labelled.text, "Improve the button contrast.");

	const sentence = sanitizeRewrite("make it better", "Sure, here's the improved prompt: Improve it.");
	assert.equal(sentence.ok, true);
	assert.equal(sentence.ok && sentence.text, "Improve it.");

	const unchanged = sanitizeRewrite("make it better", "  make it better\n");
	assert.deepEqual(unchanged, { ok: true, text: "make it better", changed: false });

	assert.equal(sanitizeRewrite("hi", "").ok, false);
	assert.deepEqual(sanitizeRewrite("edit src/a.ts", "edit the file"), {
		ok: false,
		reason: "dropped src/a.ts",
	});
	assert.equal(
		sanitizeRewrite("keep ```\ncode\n``` intact", "keep ```\ncode\n``` intact\n\nand more ```\nfence\n```").ok,
		false,
	);
	assert.deepEqual(sanitizeRewrite("short prompt", `${"padding ".repeat(200)}`), {
		ok: false,
		reason: "grew too much",
	});
	assert.deepEqual(
		sanitizeRewrite(`${"This is a reasonably long sentence. ".repeat(8)}`, "Do it."),
		{ ok: false, reason: "lost content" },
	);
	assert.deepEqual(sanitizeRewrite("make it better", "Sure! I can rewrite that for you."), {
		ok: false,
		reason: "answered instead of rewriting",
	});
});

test("conversation excerpts stay small, labelled, and reference-only", () => {
	const branch = [
		{ type: "custom", customType: "x" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer one" }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ignored" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "y".repeat(900) }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } },
	];
	const excerpt = excerptRecentContext(branch);
	assert.ok(excerpt);
	assert.ok(excerpt!.includes("Assistant: answer two"));
	assert.ok(excerpt!.includes("User: y"));
	assert.ok(!excerpt!.includes("ignored"));
	assert.ok((excerpt!.match(/User:/g) ?? []).length <= 3);
	assert.ok(excerpt!.length < 3 * 700 + 40, "excerpt stays truncated");
	assert.equal(excerptRecentContext([]), undefined);
	assert.equal(excerptRecentContext([{ type: "message", message: { role: "user", content: "  " } }]), undefined);
});

test("the rewrite request carries the request and optional context", () => {
	const plain = buildUserContent("make it better");
	assert.ok(plain.includes("<request>\nmake it better\n</request>"));
	assert.ok(!plain.includes("<recent_conversation>"));

	const withContext = buildUserContent("  make it better  ", {
		context: "User: earlier\n\nAssistant: ok",
	});
	assert.ok(withContext.includes("<recent_conversation>"));
	assert.ok(withContext.includes("Do not rewrite it"));
	assert.ok(withContext.includes("<request>\nmake it better\n</request>"));
	assert.ok(withContext.startsWith("<recent_conversation>"));
});

test("command arguments map to actions", () => {
	assert.deepEqual(parseRewriteArgs(""), { action: "improve", text: "" });
	assert.deepEqual(parseRewriteArgs("make it better"), { action: "improve", text: "make it better" });
	assert.deepEqual(parseRewriteArgs("help"), { action: "help" });
	assert.deepEqual(parseRewriteArgs("?"), { action: "help" });
	assert.deepEqual(parseRewriteArgs("last"), { action: "last" });
	assert.deepEqual(parseRewriteArgs("model openai/gpt-5.2"), {
		action: "model",
		value: "openai/gpt-5.2",
	});
	assert.deepEqual(parseRewriteArgs("model reset"), { action: "model", value: "reset" });
	assert.deepEqual(parseRewriteArgs("model"), { action: "model", value: undefined });
	assert.deepEqual(parseRewriteArgs("context off"), { action: "context", value: false });
	assert.deepEqual(parseRewriteArgs("auto on"), { action: "improve", text: "auto on" });
	assert.deepEqual(parseRewriteArgs("lang en"), { action: "improve", text: "lang en" });
	assert.deepEqual(parseRewriteArgs("context"), { action: "context", value: undefined });
	assert.deepEqual(parseRewriteArgs("model gpt-5"), { action: "model", value: "gpt-5" });
});

test("parseRewriteArgs keeps prompts that start with a subcommand word", () => {
	for (const prompt of [
		"help me fix the login bug",
		"? why does the build fail",
		"last commit broke tests, find why",
		"context menu is broken on mobile",
		"context on the login page is lost after refresh",
		"model the user table in prisma",
	]) {
		assert.deepEqual(parseRewriteArgs(prompt), { action: "improve", text: prompt });
	}
});

test("formatters describe the last outcome and current settings", () => {
	assert.equal(formatLastRewrite(undefined), "No prompt rewrite yet.");

	const rewritten = formatLastRewrite({
		kind: "rewritten",
		original: ROUGH_PROMPT,
		text: "Improve the auth flow.",
		at: START,
	});
	assert.ok(rewritten.startsWith("rewritten · "));
	assert.ok(rewritten.includes("Original:"));
	assert.ok(rewritten.includes("Rewritten:"));
	assert.ok(rewritten.includes("Improve the auth flow."));

	const unavailable = formatLastRewrite({
		kind: "unavailable",
		original: ROUGH_PROMPT,
		reason: "timed out",
		at: START,
	});
	assert.ok(unavailable.includes("Reason: timed out"));
	assert.ok(!unavailable.includes("Rewritten:"));

	const help = formatHelp({ model: "openai/gpt-5.2", context: false }, readEnv({ PI_REWRITE_THINKING: "low" }));
	assert.ok(help.includes("model: openai/gpt-5.2"));
	assert.ok(help.includes("context: off"));
	assert.ok(help.includes("thinking: low"));
	assert.ok(help.includes("timeout: 15000ms"));
	assert.ok(!help.includes("auto"));
});

test("the system prompt forbids commentary and demands verbatim tokens", () => {
	assert.ok(REWRITER_SYSTEM_PROMPT.includes("You are a rewriter, not an assistant"));
	assert.ok(REWRITER_SYSTEM_PROMPT.includes("Output only the rewritten prompt"));
	assert.ok(REWRITER_SYSTEM_PROMPT.includes("Verbatim tokens"));
	assert.ok(REWRITER_SYSTEM_PROMPT.includes("Never invent"));
});

// ---------------------------------------------------------------------------
// Registration surface
// ---------------------------------------------------------------------------

test("the extension registers one command and the session events, nothing else", (t) => {
	const h = harness(t);
	assert.deepEqual([...h.commands.keys()], ["rewrite"]);
	assert.deepEqual([...h.events.keys()].sort(), ["session_shutdown", "session_start"]);
	assert.equal(h.events.has("input"), false, "no automatic rewriting: nothing hooks prompt submission");
});

// ---------------------------------------------------------------------------
// Review-first flows
// ---------------------------------------------------------------------------

test("/rewrite <prompt> loads the improved text into the editor", async (t) => {
	const h = harness(t, { mode: "rpc", reply: () => "Improve the auth flow in src/auth.ts." });
	await h.command(ROUGH_PROMPT);
	assert.deepEqual(h.editorWrites, ["Improve the auth flow in src/auth.ts."]);
	assert.match(h.lastNotification().text, /review it and press Enter/);
	assert.equal(h.getEditorText(), "Improve the auth flow in src/auth.ts.");
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].systemPrompt, REWRITER_SYSTEM_PROMPT);
	assert.equal(extractRequestBlock(h.requests[0].userText), ROUGH_PROMPT);
	assert.equal(h.requests[0].options.cacheRetention, "none");
	assert.equal(h.requests[0].options.reasoning, "minimal");
	assert.equal(typeof h.requests[0].options.sessionId, "string");
	// The rewrite is only a draft: the status line is handed back clean.
	assert.equal(h.statuses.get("prompt-rewriter"), undefined);
});

test("/rewrite without a prompt always asks for one", async (t) => {
	for (const mode of ["tui", "rpc"] as const) {
		const h = harness(t, { mode });
		h.setEditorText(ROUGH_PROMPT);
		await h.command("");
		assert.match(h.lastNotification().text, /Nothing to rewrite — pass the prompt/);
		assert.equal(h.requests.length, 0);
		assert.deepEqual(h.editorWrites, [], "the editor draft is not an input source");
	}
});

test("non-interactive modes reject rewrites before making a model call", async (t) => {
	const h = harness(t, { mode: "json", hasUI: false });
	await h.command(ROUGH_PROMPT);
	assert.equal(h.requests.length, 0);
	assert.match(h.errors[0] ?? "", /requires TUI or RPC mode/);
});


test("an already-clear prompt is reported and put back exactly as typed", async (t) => {
	const h = harness(t, { reply: (request) => request });
	await h.command(ROUGH_PROMPT);
	assert.deepEqual(h.editorWrites, [ROUGH_PROMPT]);
	assert.match(h.lastNotification().text, /already clear/);
});

test("rewrites report unavailability instead of failing silently", async (t) => {
	const noCreds = harness(t, { hasAuth: false });
	await noCreds.command(ROUGH_PROMPT);
	assert.match(noCreds.lastNotification().text, /Rewrite unavailable: no credentials/);
	assert.deepEqual(noCreds.editorWrites, [ROUGH_PROMPT], "the cleared draft is restored");

	const broken = harness(t, {
		streamResult: async () => {
			throw new Error("boom");
		},
	});
	await broken.command(ROUGH_PROMPT);
	assert.match(broken.lastNotification().text, /Rewrite unavailable: boom/);
	assert.equal(broken.statuses.get("prompt-rewriter"), undefined);
});

test("a hanging rewrite is abandoned at the timeout", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"], now: START });
	const h = harness(t, {
		env: { PI_REWRITE_TIMEOUT_MS: "1000" },
		streamResult: () => new Promise(() => undefined),
	});
	const pending = h.command(ROUGH_PROMPT);
	t.mock.timers.tick(2000);
	await pending;
	assert.match(h.lastNotification().text, /Rewrite unavailable: timed out/);
	assert.deepEqual(h.editorWrites, [ROUGH_PROMPT]);
});

test("Esc cancels a running rewrite in the TUI and restores the draft", async (t) => {
	const h = harness(t, { mode: "tui", streamResult: () => new Promise(() => undefined) });
	const pending = h.command(ROUGH_PROMPT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(h.statuses.get("prompt-rewriter") ?? "", /Esc to cancel/);
	assert.equal(h.press("a"), false, "other keys pass through");
	assert.equal(h.press("\x1b"), true);
	await pending;
	assert.match(h.lastNotification().text, /Rewrite cancelled/);
	assert.deepEqual(h.editorWrites, [ROUGH_PROMPT]);
	assert.equal(h.inputListeners, 0, "the Esc listener is removed");
	assert.equal(h.statuses.get("prompt-rewriter"), undefined);
});

test("a second /rewrite while one is running is refused without losing its draft", async (t) => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = harness(t, {
		streamResult: async () => {
			await gate;
			return { stopReason: "stop", content: [{ type: "text", text: "Improve the auth flow." }] };
		},
	});
	const first = h.command(ROUGH_PROMPT);
	await new Promise((resolve) => setImmediate(resolve));
	await h.command("second draft");
	assert.match(h.lastNotification().text, /already running/);
	assert.deepEqual(h.editorWrites, ["second draft"]);
	release!();
	await first;
	assert.equal(h.requests.length, 1);
	assert.equal(h.editorWrites.at(-1), "Improve the auth flow.");
});

test("/rewrite help notifies instead of opening the editor", async (t) => {
	const tui = harness(t, { mode: "tui" });
	await tui.command("last");
	assert.equal(tui.editors.at(-1)!.title, "Prompt rewriter — last");
	assert.match(tui.editors.at(-1)!.prefill, /No prompt rewrite yet/);

	await tui.command("help");
	assert.equal(tui.editors.length, 1);
	assert.match(tui.lastNotification().text, /model: session model/);

	await tui.command(ROUGH_PROMPT);
	await tui.command("last");
	assert.match(tui.editors.at(-1)!.prefill, /Rewritten:/);

	const rpc = harness(t, { mode: "rpc" });
	await rpc.command("last");
	assert.deepEqual(rpc.editors, []);
	assert.match(rpc.lastNotification().text, /No prompt rewrite yet/);
	await rpc.command("help");
	assert.match(rpc.lastNotification().text, /model: session model/);
});

test("auto subcommands are treated as prompt text, not settings", async (t) => {
	const h = harness(t, { reply: () => "Handle the auto mode." });
	await h.command("auto off");
	assert.equal(h.requests.length, 1);
	assert.equal(extractRequestBlock(h.requests[0].userText), "auto off");
	assert.equal(h.prefSaves, 0);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("settings commands persist and validate their input", async (t) => {
	const h = harness(t, { findModel: true });
	await h.command("context off");
	assert.deepEqual(h.savedPrefs(), { model: null, context: false });
	assert.match(h.lastNotification().text, /Rewrite context off/);

	await h.command("model openai/gpt-5.2");
	assert.deepEqual(h.savedPrefs(), { model: "openai/gpt-5.2", context: false });
	assert.match(h.lastNotification().text, /Rewrite model set to openai\/gpt-5.2/);

	await h.command("model reset");
	assert.deepEqual(h.savedPrefs(), { model: null, context: false });

	await h.command("model oops");
	assert.match(h.lastNotification().text, /Invalid model "oops"/);
	assert.equal(h.prefSaves, 3, "invalid refs are not persisted");
});

test("an unknown model is rejected before it can be saved", async (t) => {
	const h = harness(t, { findModel: false });
	await h.command("model ghost/model");
	assert.match(h.lastNotification().text, /Model ghost\/model not found/);
	assert.equal(h.prefSaves, 0);
});

test("a configured model is used for rewrites and reported by help", async (t) => {
	const h = harness(t, { env: { PI_REWRITE_MODEL: "openai/gpt-5.2-mini" }, reply: () => "Better prompt." });
	await h.command("help");
	assert.match(h.lastNotification().text, /model: openai\/gpt-5\.2-mini/);
	await h.command(ROUGH_PROMPT);
	assert.equal(h.requests.length, 1);
});

test("prefs files with junk fall back to defaults", async (t) => {
	const h = harness(t, { rawPrefs: "{not json" });
	await h.command("help");
	assert.match(h.lastNotification().text, /model: session model/);
	assert.match(h.lastNotification().text, /context: on/);
});

test("shutdown clears the transient status", async (t) => {
	const h = harness(t);
	await h.command(ROUGH_PROMPT);
	assert.equal(h.statuses.get("prompt-rewriter"), undefined);
	await h.fire("session_shutdown", { type: "session_shutdown" });
	assert.equal(h.statuses.get("prompt-rewriter"), undefined);
});

// ---------------------------------------------------------------------------
// Registry compatibility
// ---------------------------------------------------------------------------

test("a missing stream API is reported instead of throwing", async (t) => {
	const h = harness(t, { streamApi: "none" });
	await h.command(ROUGH_PROMPT);
	assert.match(h.lastNotification().text, /cannot run requests/);
});

test("the registry bridge prefers streamSimple and falls back to complete", async (t) => {
	const streaming = harness(t, { streamApi: "streamSimple", reply: () => "Streamed." });
	await streaming.command(ROUGH_PROMPT);
	assert.deepEqual(streaming.editorWrites, ["Streamed."]);
	assert.equal(streaming.requests[0].options.reasoning, "minimal");

	const completing = harness(t, { streamApi: "complete", reply: () => "Completed prompt." });
	await completing.command(ROUGH_PROMPT);
	assert.deepEqual(completing.editorWrites, ["Completed prompt."]);
	assert.equal(completing.requests[0].options.reasoning, undefined);
});

test("thinking can be handed to the provider default", async (t) => {
	const h = harness(t, { env: { PI_REWRITE_THINKING: "default" }, reply: () => "Better prompt." });
	await h.command(ROUGH_PROMPT);
	assert.equal(h.requests[0].options.reasoning, undefined);
});

test("conversation context is only sent when it is enabled", async (t) => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "the parser is broken" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "which parser?" }] } },
	];
	const withContext = harness(t, { branch });
	await withContext.command("that one, obviously");
	assert.match(withContext.requests[0].userText, /<recent_conversation>/);
	assert.match(withContext.requests[0].userText, /which parser\?/);

	const withoutContext = harness(t, { branch, env: { PI_REWRITE_CONTEXT: "off" } });
	await withoutContext.command("that one, obviously");
	assert.doesNotMatch(withoutContext.requests[0].userText, /<recent_conversation>/);
});
