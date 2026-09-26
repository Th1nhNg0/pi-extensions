/**
 * Shared command-surface helpers for the extensions in this package.
 *
 * Every extension here exposes one slash command with subcommands, a persisted
 * preferences file, and a help screen. Doing that four times produced four
 * different spellings of the same thing: three completion implementations,
 * three `Unknown subcommand` messages, two help layouts, four prefs
 * load/save/normalize trios, and three hardcoded `~/.pi/agent` paths that
 * ignore `PI_CODING_AGENT_DIR`.
 *
 * One command table now drives all three surfaces — help text, argument
 * completions, and the unknown-subcommand message — so they cannot drift
 * again. Everything here is mechanical: no domain logic, no module state, and
 * no runtime import from pi (only `import type`), so the extension test suite
 * keeps running under plain `node --test`.
 */

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

export interface CommandSpec {
	/** Subcommand as typed, or "" for the bare command. */
	name: string;
	/** One-line description used by help and by completions. */
	description: string;
	/** Values accepted after the name; drives completions and the usage hint. */
	values?: readonly string[];
	/** Usage hint for dynamic values or bare-command arguments. */
	hint?: string;
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface ParsedSubcommand {
	/** Lowercased subcommand, or "" when only the command was typed. */
	sub: string;
	/** Everything after the subcommand, trimmed. */
	rest: string;
}

/** Split `/cmd sub rest of args` into its subcommand and the remaining args. */
export function parseSubcommand(args: string): ParsedSubcommand {
	const trimmed = args.trim();
	const spaceIndex = trimmed.indexOf(" ");
	if (spaceIndex === -1) {
		return { sub: trimmed.toLowerCase(), rest: "" };
	}
	return {
		sub: trimmed.slice(0, spaceIndex).toLowerCase(),
		rest: trimmed.slice(spaceIndex + 1).trim(),
	};
}

/** `/usage refresh [all|<provider>|active]`, or `/rewrite <prompt>` for bare arguments. */
export function usageOf(command: string, spec: CommandSpec): string {
	if (spec.name.length === 0) {
		return spec.hint ? `${command} ${spec.hint}` : command;
	}
	const hint = spec.hint ?? (spec.values && spec.values.length > 0 ? `[${spec.values.join("|")}]` : "");
	return hint.length > 0 ? `${command} ${spec.name} ${hint}` : `${command} ${spec.name}`;
}

/** `Usage: /usage | toggle [bars|percent|off] | refresh [all|<provider>|active]` */
export function usageLine(command: string, specs: readonly CommandSpec[]): string {
	const visible = specs.map((spec) => usageOf(command, spec));
	const parts = visible.map((usage, index) =>
		index === 0 ? usage : usage.slice(command.length).trimStart(),
	);
	return `Usage: ${parts.join(" | ")}`;
}

/** One wording for every extension, derived from the same table as the help. */
export function unknownSubcommand(command: string, sub: string, specs: readonly CommandSpec[]): string {
	return `Unknown subcommand "${sub}". ${usageLine(command, specs)}`;
}

/**
 * Completions for `<command> <sub> <value>`.
 *
 * `dynamic` covers subcommands whose values are not a fixed enum (provider
 * ids, session names, ...); it is asked only for the subcommand being typed.
 * Returns null when nothing matches, which is what `getArgumentCompletions`
 * expects.
 */
export function argumentCompletions(
	specs: readonly CommandSpec[],
	prefix: string,
	dynamic?: (sub: string, rest: string) => CompletionItem[] | undefined,
): CompletionItem[] | null {
	const trimmed = prefix.trimStart();
	const spaceIndex = trimmed.indexOf(" ");
	if (spaceIndex === -1) {
		const typed = trimmed.toLowerCase();
		const matches = specs
			.filter((spec) => spec.name.length > 0 && spec.name.toLowerCase().startsWith(typed))
			.map((spec) => ({ value: spec.name, label: spec.name, description: spec.description }));
		return matches.length > 0 ? matches : null;
	}

	const sub = trimmed.slice(0, spaceIndex).toLowerCase();
	const rest = trimmed.slice(spaceIndex + 1).trimStart().toLowerCase();
	const spec = specs.find((candidate) => candidate.name.toLowerCase() === sub);
	const provided = dynamic?.(sub, rest) ?? [];
	const candidates =
		provided.length > 0
			? provided
			: (spec?.values ?? []).map((value) => ({
					value: `${sub} ${value}`,
					label: `${sub} ${value}`,
					description: spec?.description ?? "",
				}));
	const matches = candidates.filter((item) => item.value.toLowerCase().startsWith(`${sub} ${rest}`));
	return matches.length > 0 ? matches : null;
}

export interface HelpSection {
	heading: string;
	lines: readonly string[];
}

export interface HelpOptions {
	/** Prefix for the header line: `${title} commands:`. */
	title: string;
	/** The slash command, e.g. "/throughput". */
	command: string;
	specs: readonly CommandSpec[];
	/** Extra blocks, typically the persisted settings. */
	sections?: readonly HelpSection[];
}

/**
 * The one help layout: a header, one aligned line per subcommand, then optional
 * sections. Rendered through `showText`, so every extension shows its help the
 * same way.
 */
export function commandHelp(options: HelpOptions): string {
	const usages = options.specs.map((spec) => usageOf(options.command, spec));
	const width = usages.reduce((max, usage) => Math.max(max, usage.length), 0);
	const lines = [`${options.title} commands:`, ""];
	options.specs.forEach((spec, index) => {
		lines.push(`  ${usages[index].padEnd(width)}  ${spec.description}`);
	});
	for (const section of options.sections ?? []) {
		lines.push("", section.heading);
		for (const line of section.lines) {
			lines.push(`  ${line}`);
		}
	}
	return lines.join("\n");
}

/** `on`, `true`, `yes`, `1`, `enable[d]` → true; the off equivalents → false. */
export function parseOnOff(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalized)) {
		return true;
	}
	if (["off", "false", "no", "0", "disable", "disabled"].includes(normalized)) {
		return false;
	}
	return undefined;
}

/** Next value in a cycle, wrapping around; an unknown current value starts at the first. */
export function cycleMode<T extends string>(current: T, modes: readonly T[]): T {
	const index = modes.indexOf(current);
	return modes[(index + 1) % modes.length] as T;
}

/** Match a value against a fixed enum; undefined for "" and for anything unknown. */
export function parseMode<T extends string>(value: string, modes: readonly T[]): T | undefined {
	const normalized = value.trim().toLowerCase();
	return modes.find((mode) => mode.toLowerCase() === normalized);
}

/** The one wording for a rejected enum value, shared by every toggle handler. */
export function unknownMode(value: string, modes: readonly string[]): string {
	return `Unknown mode "${value.trim()}". Options: ${modes.join(", ")}`;
}
// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Show multi-line output (readouts, diffs).
 *
 * Interactive mode opens the scrollable viewer; RPC keeps the fire-and-forget
 * notification, because there `editor` is a blocking dialog the client must
 * answer. Print/JSON modes have no UI and are skipped.
 */
export async function showText(ctx: ExtensionContext, title: string, text: string): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}
	if (ctx.mode === "tui") {
		await ctx.ui.editor(title, text);
		return;
	}
	ctx.ui.notify(text, "info");
}

/** Show command help as an on-screen notification, never in the editor. */
export function showHelp(ctx: ExtensionContext, text: string): void {
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.notify(text, "info");
}

// ---------------------------------------------------------------------------
// Preferences files
// ---------------------------------------------------------------------------

/** Pi's agent directory: `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`. */
export function agentDirPath(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv && fromEnv.length > 0) {
		return fromEnv.startsWith("~") ? path.join(os.homedir(), fromEnv.slice(1)) : fromEnv;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export function agentFilePath(fileName: string, dir?: string): string {
	return path.join(dir ?? agentDirPath(), fileName);
}

/** Parse a JSON file, returning undefined for any failure (missing, unreadable, malformed). */
export function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Write JSON atomically: a temporary file in the same directory is renamed over
 * the target, with a direct write as the fallback when rename is unavailable
 * (some Windows and network filesystems). Throws on failure so callers can log.
 */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(tmpPath, contents, "utf8");
		await fs.promises.rename(tmpPath, filePath);
	} catch {
		await fs.promises.writeFile(filePath, contents, "utf8");
	} finally {
		await fs.promises.unlink(tmpPath).catch(() => undefined);
	}
}

/** Load a preferences file through its normalizer; defaults handle anything odd. */
export function loadPrefs<T>(
	fileName: string,
	normalize: (value: unknown) => T,
	dir?: string,
): T {
	return normalize(readJsonFile(agentFilePath(fileName, dir)));
}

/**
 * Persist preferences. Failures are logged with the extension's prefix and
 * swallowed: prefs are a convenience, never a reason to break a session.
 */
export async function savePrefs(
	fileName: string,
	value: unknown,
	scope: string,
	dir?: string,
): Promise<void> {
	try {
		await writeJsonFile(agentFilePath(fileName, dir), value);
	} catch (error) {
		console.error(`${scope} failed to save prefs:`, error);
	}
}
