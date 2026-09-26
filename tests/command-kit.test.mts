import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	agentDirPath,
	agentFilePath,
	argumentCompletions,
	commandHelp,
	cycleMode,
	loadPrefs,
	parseMode,
	parseOnOff,
	parseSubcommand,
	savePrefs,
	showHelp,
	showText,
	unknownMode,
	unknownSubcommand,
	usageLine,
	usageOf,
	writeJsonFile,
	type CommandSpec,
} from "../extensions/shared/command-kit.ts";

/** A tiny in-memory fs so prefs never touch the real agent directory. */
function fsMock(
	t: TestContext,
	options: { read?: string | (() => string); failRename?: boolean } = {},
) {
	t.mock.method(console, "error", () => {});
	t.mock.method(fs, "readFileSync", () => {
		if (typeof options.read === "function") {
			return options.read();
		}
		if (options.read === undefined) {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		}
		return options.read;
	});
	const mkdirs: string[] = [];
	t.mock.method(fs.promises, "mkdir", async (dir: unknown) => {
		mkdirs.push(String(dir));
	});
	const writes: Array<{ path: string; data: string }> = [];
	t.mock.method(fs.promises, "writeFile", async (filePath: unknown, data: unknown) => {
		writes.push({ path: String(filePath), data: String(data) });
	});
	const renames: Array<{ from: string; to: string }> = [];
	t.mock.method(fs.promises, "rename", async (from: unknown, to: unknown) => {
		if (options.failRename) {
			throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
		}
		renames.push({ from: String(from), to: String(to) });
	});
	const unlinks: string[] = [];
	t.mock.method(fs.promises, "unlink", async (filePath: unknown) => {
		unlinks.push(String(filePath));
	});
	return { mkdirs, writes, renames, unlinks };
}

function fakeCtx(options: { mode: string; hasUI: boolean }) {
	const editors: Array<{ title: string; text: string }> = [];
	const notifications: string[] = [];
	const ctx = {
		mode: options.mode,
		hasUI: options.hasUI,
		ui: {
			editor: async (title: string, text: string) => {
				editors.push({ title, text });
				return undefined;
			},
			notify: (text: string) => {
				notifications.push(text);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, editors, notifications };
}

const SPECS: readonly CommandSpec[] = [
	{ name: "", description: "show everything" },
	{ name: "toggle", description: "cycle the footer style", values: ["bars", "percent", "off"] },
	{ name: "refresh", description: "force a refresh", hint: "[all|<provider>|active]" },
	{ name: "help", description: "show this help" },
];

// ---------------------------------------------------------------------------

test("parseSubcommand splits the subcommand from the rest", () => {
	assert.deepEqual(parseSubcommand(""), { sub: "", rest: "" });
	assert.deepEqual(parseSubcommand("   "), { sub: "", rest: "" });
	assert.deepEqual(parseSubcommand("toggle"), { sub: "toggle", rest: "" });
	assert.deepEqual(parseSubcommand("TOGGLE   off "), { sub: "toggle", rest: "off" });
	assert.deepEqual(parseSubcommand(" refresh all "), { sub: "refresh", rest: "all" });
	assert.deepEqual(parseSubcommand("model openai/gpt-5.2"), { sub: "model", rest: "openai/gpt-5.2" });
});

test("usageOf renders the bare command, enum values, and explicit hints", () => {
	assert.equal(usageOf("/usage", SPECS[0]), "/usage");
	assert.equal(usageOf("/usage", SPECS[1]), "/usage toggle [bars|percent|off]");
	assert.equal(usageOf("/usage", SPECS[2]), "/usage refresh [all|<provider>|active]");
	assert.equal(usageOf("/rewrite", { name: "", description: "", hint: "<prompt>" }), "/rewrite <prompt>");
});

test("usageLine lists every entry", () => {
	assert.equal(
		usageLine("/usage", SPECS),
		"Usage: /usage | toggle [bars|percent|off] | refresh [all|<provider>|active] | help",
	);
	assert.equal(usageLine("/discord", [{ name: "status", description: "" }]), "Usage: /discord status");
});



test("unknownSubcommand reuses the same table as the help", () => {
	assert.equal(
		unknownSubcommand("/throughput", "explode", [
			{ name: "", description: "" },
			{ name: "toggle", description: "", values: ["on", "off"] },
		]),
		'Unknown subcommand "explode". Usage: /throughput | toggle [on|off]',
	);
});

test("completions cover both levels and fall back to null", () => {
	const first = argumentCompletions(SPECS, "to");
	assert.deepEqual(first, [{ value: "toggle", label: "toggle", description: "cycle the footer style" }]);
	assert.equal(argumentCompletions(SPECS, "zz"), null);
	// The bare entry is not a suggestion.
	assert.deepEqual(
		argumentCompletions([{ name: "", description: "bare" }], ""),
		null,
	);

	const second = argumentCompletions(SPECS, "toggle ");
	assert.deepEqual(
		second?.map((item) => item.value),
		["toggle bars", "toggle percent", "toggle off"],
	);
	assert.equal(second?.[0].description, "cycle the footer style");
	assert.deepEqual(argumentCompletions(SPECS, "toggle p"), [
		{ value: "toggle percent", label: "toggle percent", description: "cycle the footer style" },
	]);
	// No enum and no dynamic provider → nothing to suggest.
	assert.equal(argumentCompletions(SPECS, "refresh "), null);
});

test("completions use enum descriptions and dynamic values", () => {
	const specs: readonly CommandSpec[] = [
		{ name: "privacy", description: "set privacy", values: ["strict", "project"] },
	];
	assert.deepEqual(argumentCompletions(specs, "privacy s"), [
		{ value: "privacy strict", label: "privacy strict", description: "set privacy" },
	]);

	const dynamic = (_sub: string, rest: string) =>
		[
			{ value: "refresh all", label: "refresh all", description: "every provider" },
			{ value: "refresh deepseek", label: "refresh deepseek", description: "one provider" },
		].filter((item) => item.value.startsWith(`refresh ${rest}`));
	assert.deepEqual(argumentCompletions(SPECS, "refresh d", dynamic), [
		{ value: "refresh deepseek", label: "refresh deepseek", description: "one provider" },
	]);
});

test("commandHelp renders one layout for every extension", () => {
	const help = commandHelp({
		title: "Live throughput",
		command: "/throughput",
		specs: SPECS,
		sections: [{ heading: "Settings", lines: ["mode: on"] }],
	});
	const lines = help.split("\n");
	assert.equal(lines[0], "Live throughput commands:");
	assert.equal(lines[1], "");
	// Description column is aligned across usages of different length.
	assert.match(lines[2], /^ {2}\/throughput {2,}show everything$/);
	assert.ok(help.includes("/throughput toggle [bars|percent|off]"));
	assert.ok(help.includes("Settings\n  mode: on"));
});

test("on/off parsing accepts the usual spellings and rejects the rest", () => {
	for (const value of ["on", "ON", " true ", "yes", "1", "enable", "enabled"]) {
		assert.equal(parseOnOff(value), true, value);
	}
	for (const value of ["off", "OFF", "false", "no", "0", "disable", "disabled"]) {
		assert.equal(parseOnOff(value), false, value);
	}
	for (const value of ["", "maybe", "2", "onwards"]) {
		assert.equal(parseOnOff(value), undefined, value);
	}
});

test("modes parse, report, and cycle consistently", () => {
	const modes = ["bars", "percent", "off"] as const;
	assert.equal(parseMode("PERCENT", modes), "percent");
	assert.equal(parseMode("", modes), undefined);
	assert.equal(parseMode("fancy", modes), undefined);
	assert.equal(unknownMode(" fancy ", modes), 'Unknown mode "fancy". Options: bars, percent, off');

	assert.equal(cycleMode("bars", modes), "percent");
	assert.equal(cycleMode("off", modes), "bars");
	assert.equal(cycleMode("unknown" as (typeof modes)[number], modes), "bars");
});

test("showText uses the viewer in TUI and the notification elsewhere", async () => {
	const tui = fakeCtx({ mode: "tui", hasUI: true });
	await showText(tui.ctx, "Usage", "line one\nline two");
	assert.deepEqual(tui.editors, [{ title: "Usage", text: "line one\nline two" }]);
	assert.deepEqual(tui.notifications, []);

	const rpc = fakeCtx({ mode: "rpc", hasUI: true });
	await showText(rpc.ctx, "Usage", "line one");
	assert.deepEqual(rpc.editors, []);
	assert.deepEqual(rpc.notifications, ["line one"]);

	const headless = fakeCtx({ mode: "print", hasUI: false });
	await showText(headless.ctx, "Usage", "line one");
	assert.deepEqual(headless.editors, []);
	assert.deepEqual(headless.notifications, []);
});

test("showHelp notifies on screen without opening the editor", () => {
	const tui = fakeCtx({ mode: "tui", hasUI: true });
	showHelp(tui.ctx, "Usage\n/command help");
	assert.deepEqual(tui.editors, []);
	assert.deepEqual(tui.notifications, ["Usage\n/command help"]);

	const headless = fakeCtx({ mode: "print", hasUI: false });
	showHelp(headless.ctx, "Usage");
	assert.deepEqual(headless.notifications, []);
});

test("the agent directory follows PI_CODING_AGENT_DIR", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(agentDirPath(), path.join(os.homedir(), ".pi", "agent"));

		process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent";
		assert.equal(agentDirPath(), "/tmp/custom-agent");

		process.env.PI_CODING_AGENT_DIR = "~/elsewhere";
		assert.equal(agentDirPath(), path.join(os.homedir(), "elsewhere"));

		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(agentFilePath("prefs.json"), path.join(os.homedir(), ".pi", "agent", "prefs.json"));
		assert.equal(agentFilePath("prefs.json", "/tmp/dir"), path.join("/tmp/dir", "prefs.json"));
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	}
});

test("loadPrefs reads through the normalizer and defaults on anything odd", (t) => {
	fsMock(t, { read: '{"mode":"off"}' });
	const prefs = loadPrefs("x-prefs.json", (value) => {
		const record = (value ?? {}) as { mode?: string };
		return { mode: record.mode ?? "bars" };
	});
	assert.deepEqual(prefs, { mode: "off" });

	fsMock(t, { read: "{oops" });
	assert.deepEqual(loadPrefs("x-prefs.json", () => ({ mode: "bars" })), { mode: "bars" });
});

test("writeJsonFile writes a temp file and renames it over the target", async (t) => {
	const mock = fsMock(t);
	const target = path.join("/tmp/agent", "x-prefs.json");
	await writeJsonFile(target, { mode: "off" });

	assert.deepEqual(mock.mkdirs, ["/tmp/agent"]);
	assert.equal(mock.writes.length, 1);
	assert.match(mock.writes[0].path, /x-prefs\.json\.\d+\.\d+\.tmp$/);
	assert.deepEqual(JSON.parse(mock.writes[0].data), { mode: "off" });
	assert.equal(mock.writes[0].data.endsWith("\n"), true);
	assert.deepEqual(mock.renames, [{ from: mock.writes[0].path, to: target }]);
	assert.deepEqual(mock.unlinks, [mock.writes[0].path], "the temp file is always cleaned up");
});

test("writeJsonFile falls back to a direct write when rename fails", async (t) => {
	const mock = fsMock(t, { failRename: true });
	const target = "/tmp/x-prefs.json";
	await writeJsonFile(target, { mode: "on" });

	assert.equal(mock.writes.length, 2);
	assert.match(mock.writes[0].path, /\.tmp$/);
	assert.equal(mock.writes[1].path, target);
	assert.deepEqual(JSON.parse(mock.writes[1].data), { mode: "on" });
});

test("savePrefs logs and swallows failures instead of breaking a session", async (t) => {
	const errors: unknown[][] = [];
	t.mock.method(console, "error", (...args: unknown[]) => {
		errors.push(args);
	});
	t.mock.method(fs.promises, "mkdir", async () => {
		throw new Error("read-only fs");
	});

	await savePrefs("x-prefs.json", { mode: "off" }, "[scope]");
	assert.equal(errors.length, 1);
	assert.match(String(errors[0][0]), /^\[scope\] failed to save prefs:/);
});
