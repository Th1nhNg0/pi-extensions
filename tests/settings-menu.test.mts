import assert from "node:assert/strict";
import fs from "node:fs";
import test, { before, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import discordPresenceExtension from "../extensions/discord-presence.ts";
import liveThroughput from "../extensions/live-throughput-status.ts";
import promptRewriter from "../extensions/prompt-rewriter.ts";
import subscriptionUsage from "../extensions/subscription-usage.ts";
import { menuSupported } from "../extensions/shared/settings-menu.ts";

/** Screen fields read by these assertions; the real kit validates the rest. */
interface StubScreen {
	kind: string;
	items?: Array<{ id: string; action?: string; values?: readonly string[]; to?: string }>;
}

interface StubMenuRun {
	definition: {
		start: string;
		screens: Record<string, (context: { state: unknown }) => StubScreen>;
		actions: Record<string, (context: unknown) => unknown>;
	};
	options: {
		getState(context: { ctx: ExtensionCommandContext; signal: AbortSignal }): unknown;
	};
}

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** The stub installed by scripts/test.sh records every runMenu call here. */
async function recordedMenuRuns(): Promise<StubMenuRun[]> {
	const kit = (await import("@narumitw/pi-tui-kit")) as unknown as { menuRuns: StubMenuRun[] };
	return kit.menuRuns;
}

// Load the menu kit before any test mocks fs.readFileSync: some Node builds
// read ESM sources through it, so a first import inside a test fails with the
// mocked ENOENT. Later imports, including the extensions' lazy one, hit the cache.
before(async () => {
	await recordedMenuRuns();
});

/** Prefs and credentials read as absent, so nothing touches the real agent dir. */
function noStoredFiles(t: TestContext): void {
	t.mock.method(fs, "readFileSync", () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	});
}

/** A TUI command context: menus need mode, hasUI, and ui.custom. */
function tuiCtx(): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: {
			getAvailable: () => [{ provider: "test-provider", id: "test-model", name: "Test Model" }],
			find: () => undefined,
		},
		ui: {
			custom: () => undefined,
			theme: { fg: (_color: string, text: string) => text },
			notify: () => {},
			setStatus: () => {},
			editor: async () => undefined,
		},
	} as unknown as ExtensionCommandContext;
}

/** Register one extension against a fake API and return its command handlers. */
function registerCommands(extension: (pi: ExtensionAPI) => void): Map<string, CommandHandler> {
	const commands = new Map<string, CommandHandler>();
	extension({
		on: () => {},
		registerCommand: (name: string, definition: { handler: CommandHandler }) => {
			commands.set(name, definition.handler);
		},
	} as unknown as ExtensionAPI);
	return commands;
}

/** Open `command` with no arguments and return the menu definition it recorded. */
async function openBareCommand(
	t: TestContext,
	extension: (pi: ExtensionAPI) => void,
	command: string,
): Promise<StubMenuRun> {
	noStoredFiles(t);
	const handler = registerCommands(extension).get(command);
	assert.ok(handler, `expected /${command} to be registered`);
	const runs = await recordedMenuRuns();
	const before = runs.length;
	await handler("", tuiCtx());
	assert.equal(runs.length, before + 1, `expected bare /${command} to open a menu`);
	const run = runs.at(-1);
	assert.ok(run, "expected a recorded menu run");
	return run;
}

test("menuSupported requires TUI mode, a UI, and ui.custom", () => {
	assert.equal(menuSupported({ mode: "tui", hasUI: true, ui: { custom: () => undefined } }), true);
	assert.equal(menuSupported({ mode: "tui", hasUI: true, ui: {} }), false);
	assert.equal(
		menuSupported({ mode: "tui", hasUI: false, ui: { custom: () => undefined } }),
		false,
	);
	assert.equal(menuSupported({ mode: "rpc", hasUI: true, ui: { custom: () => undefined } }), false);
	assert.equal(menuSupported({ mode: "print", hasUI: false }), false);
});

test("bare /throughput opens the settings menu and persists a style change", async (t) => {
	const writes: Array<{ path: string; data: string }> = [];
	noStoredFiles(t);
	t.mock.method(fs.promises, "mkdir", async () => undefined);
	t.mock.method(fs.promises, "writeFile", async (filePath: unknown, data: unknown) => {
		writes.push({ path: String(filePath), data: String(data) });
	});
	t.mock.method(fs.promises, "rename", async () => undefined);
	t.mock.method(fs.promises, "unlink", async () => undefined);

	const handler = registerCommands(liveThroughput).get("throughput");
	assert.ok(handler);
	const runs = await recordedMenuRuns();
	const before = runs.length;
	const ctx = tuiCtx();
	await handler("", ctx);
	assert.equal(runs.length, before + 1, "expected bare /throughput to open a menu");
	const run = runs.at(-1);
	assert.ok(run);
	assert.equal(run.definition.start, "main");

	const settings = run.definition.screens.settings?.({ state: { mode: "on" } });
	assert.ok(settings);
	assert.equal(settings.kind, "settings");
	const item = settings.items?.find((candidate) => candidate.id === "mode");
	assert.equal(item?.action, "set-mode");
	assert.deepEqual(item?.values, ["On", "Off"]);

	const action = run.definition.actions["set-mode"];
	assert.equal(typeof action, "function");
	const result = await action?.({ ctx, itemId: "mode", value: "Off" });
	assert.deepEqual(result, { kind: "stay" });
	assert.ok(
		writes.some(
			(write) => write.path.includes("live-throughput-prefs.json") && write.data.includes('"off"'),
		),
		"expected the new mode to be saved",
	);
});

test("bare /usage opens the settings menu", async (t) => {
	const run = await openBareCommand(t, subscriptionUsage, "usage");
	const settings = run.definition.screens.settings?.({ state: { mode: "bars" } });
	assert.ok(settings);
	assert.deepEqual(
		settings.items?.map((item) => item.id),
		["mode"],
	);
	assert.deepEqual(settings.items?.[0]?.values, ["Bars", "Percent", "Off"]);
	assert.equal(typeof run.definition.actions["set-mode"], "function");
});

test("bare /discord opens the settings menu with every preference", async (t) => {
	const run = await openBareCommand(t, discordPresenceExtension, "discord");
	const settings = run.definition.screens.settings?.({
		state: {
			enabled: true,
			privacy: "strict",
			showCost: true,
			buttons: true,
			costOverride: false,
			buttonsOverride: false,
		},
	});
	assert.ok(settings);
	assert.deepEqual(
		settings.items?.map((item) => item.id),
		["enabled", "privacy", "cost", "buttons"],
	);
	for (const item of settings.items ?? []) {
		assert.equal(typeof run.definition.actions[item.action ?? ""], "function", item.id);
	}
});

test("bare /rewrite opens the settings menu with model and context", async (t) => {
	const run = await openBareCommand(t, promptRewriter, "rewrite");
	const settings = run.definition.screens.settings?.({ state: { model: null, context: true } });
	assert.ok(settings);
	assert.deepEqual(
		settings.items?.map((item) => item.id),
		["model", "context"],
	);
	const model = run.definition.screens.model?.({ state: { model: null, models: [] } });
	assert.ok(model);
	assert.equal(model.kind, "choice");
	assert.equal(model.items?.[0]?.id, "session");
	assert.equal(typeof run.definition.actions["set-context"], "function");
	assert.equal(typeof run.definition.actions["set-model"], "function");
});
