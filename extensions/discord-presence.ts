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
 * Bare `/discord` opens the same interactive settings menu as `/goal`; every
 * setting is also available as a subcommand.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	agentFilePath,
	argumentCompletions,
	commandHelp,
	cycleMode,
	parseMode,
	parseOnOff,
	parseSubcommand,
	readJsonFile,
	showHelp,
	showText,
	unknownMode,
	unknownSubcommand,
	writeJsonFile,
	type CommandSpec,
} from "./shared/command-kit.ts";
import { menuSupported, showExtensionMenu } from "./shared/settings-menu.ts";
import { SubagentTracker } from "./discord/subagent-tracker.ts";
import {
	createDiscordPresenceTransport,
	isWslEnvironment,
	NPIPERELAY_ENV,
	resolveDiscordTransportMode,
	TRANSPORT_ENV,
	WslDiscordIpcTransport,
} from "./discord/transport.ts";
import type { DiscordPresenceTransport, DiscordTransportMode } from "./discord/transport.ts";
import {
	ACTION_BADGE_COLORS,
	ACTION_BADGE_URLS,
	classifyToolAction,
	formatAction,
	formatPhase,
	pickHighestPriorityAction,
} from "./discord/actions.ts";
import type { PresenceAction, PresencePhase } from "./discord/actions.ts";
import {
	formatDiscordModelLabel,
	formatModelLabel,
	isReasoningSupported,
	truncateText,
} from "./discord/model-labels.ts";
import {
	BUTTONS_ENV,
	DEFAULT_CLIENT_ID,
	LARGE_IMAGE_ENV,
	PRIVACY_MODES,
	SMALL_IMAGES_ENV,
	normalizePrivacyMode,
	parsePrivacyMode,
} from "./discord/activity.ts";
import type { PresencePrivacyMode } from "./discord/activity.ts";
import {
	asRecord,
	emptyUsageTotals,
	isSubagentRecord,
	normalizeContextUsage,
} from "./discord/session-state.ts";
import type {
	ContextSnapshot,
	PresenceState,
	PresenceStateStore,
	SessionRecord,
	UsageTotals,
} from "./discord/session-state.ts";
import {
	CLIENT_ID_ENV,
	DiscordPresenceManager,
	PRIVACY_ENV,
	defaultLogger,
} from "./discord/publisher.ts";
import { DEFAULT_STATE_PATH, FilePresenceStateStore } from "./discord/state-store.ts";
import type { FilePresenceStateStoreOptions } from "./discord/state-store.ts";
import {
	collectUsageFromEntries,
	extractUsage,
	formatCost,
	formatTokenCount,
	mergeUsageTotals,
} from "./discord/session-usage.ts";
import type { AggregateSummary, UsageDelta } from "./discord/session-usage.ts";

export {
	SubagentTracker,
	createDiscordPresenceTransport,
	isWslEnvironment,
	NPIPERELAY_ENV,
	resolveDiscordTransportMode,
	TRANSPORT_ENV,
	WslDiscordIpcTransport,
};
export {
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_REQUEST_EVENT,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REPLY_EVENT_PREFIX,
} from "./discord/subagent-tracker.ts";
export type {
	SubagentTrackerEventBus,
	SubagentTrackerOptions,
} from "./discord/subagent-tracker.ts";
export type { DiscordPresenceTransport, DiscordTransportMode };
export {
	ACTION_BADGE_COLORS,
	ACTION_BADGE_URLS,
	classifyToolAction,
	formatAction,
	formatPhase,
	pickHighestPriorityAction,
};
export type { PresenceAction, PresencePhase };
export { formatDiscordModelLabel, formatModelLabel, isReasoningSupported, truncateText };
export {
	BUTTONS_ENV,
	DEFAULT_BUTTONS,
	DEFAULT_CLIENT_ID,
	DEFAULT_LARGE_IMAGE_KEY,
	DEFAULT_LARGE_IMAGE_TEXT,
	LARGE_IMAGE_ENV,
	PRIVACY_MODES,
	SMALL_IMAGES_ENV,
	attachAssetsAndButtons,
	buildActivity,
	buildAggregateActivity,
	buildMultiSessionActivity,
	buildSingleSessionActivity,
	formatMultiSessionDetails,
	formatMultiSessionState,
	formatPublicMetrics,
	formatSingleSessionDetails,
	formatSingleSessionState,
	isActivityEqual,
	normalizePrivacyMode,
	parsePrivacyMode,
	summarizeModels,
} from "./discord/activity.ts";
export type {
	ActivityBuildOptions,
	PresenceActivity,
	PresencePrivacyMode,
	PresenceSnapshot,
} from "./discord/activity.ts";
export {
	CLIENT_ID_ENV,
	DEFAULT_MIN_PUBLISH_INTERVAL_MS,
	DiscordPresenceManager,
	isRateLimitError,
	isRegistryLockError,
	MIN_INTERVAL_ENV,
	PRESENCE_REASSERT_INTERVAL_MS,
	PRIVACY_ENV,
	RATE_LIMIT_BACKOFF_MS,
} from "./discord/publisher.ts";
export type { PresenceManagerOptions, PresenceStatus } from "./discord/publisher.ts";
export {
	DEFAULT_STATE_PATH,
	FilePresenceStateStore,
	emptyUsageTotals,
	isSubagentRecord,
	normalizeContextUsage,
};
export type {
	ContextSnapshot,
	FilePresenceStateStoreOptions,
	PresenceState,
	PresenceStateStore,
	SessionRecord,
	UsageTotals,
};
export { collectUsageFromEntries, extractUsage, formatCost, formatTokenCount, mergeUsageTotals };
export type { AggregateSummary, UsageDelta };

export const SHOW_COST_ENV = "PI_DISCORD_SHOW_COST";

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const IS_SUBAGENT_ENV = "PI_IS_SUBAGENT";

/** Detect whether the current process is running inside a subagent child run. */
export function isSubagentEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(
		env.PI_SUBAGENT_CHILD === "1" ||
			env.PI_SUBAGENT_CHILD === "true" ||
			env.PI_IS_SUBAGENT === "1" ||
			env.PI_IS_SUBAGENT === "true",
	);
}

/** Detect whether a session context belongs to a subagent child run. */
export function isSubagentSession(
	ctx?: {
		cwd?: string;
		sessionManager?: { getSessionFile?: () => string | undefined };
	},
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (isSubagentEnvironment(env)) return true;
	if (!ctx) return false;
	const cwd = ctx.cwd ?? "";
	if (
		cwd.includes("pi-worktree-") ||
		cwd.includes("/.pi/subagents/") ||
		cwd.includes("\\.pi\\subagents\\")
	) {
		return true;
	}
	const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "";
	if (
		sessionFile.includes("pi-worktree-") ||
		sessionFile.includes("/.pi/subagents/") ||
		sessionFile.includes("\\.pi\\subagents\\")
	) {
		return true;
	}
	return false;
}

export const DEFAULT_PREFS_PATH = agentFilePath("discord-presence-prefs.json");

type GitCommandResult = {
	stdout: string;
	code: number;
};

/** One table drives the help, the completions, and the unknown-subcommand message. */
export const DISCORD_SPECS: readonly CommandSpec[] = [
	{ name: "status", description: "view active sessions & diagnostics" },
	{ name: "privacy", values: PRIVACY_MODES, description: "set privacy mode" },
	{ name: "toggle", values: ["on", "off"], description: "toggle presence on or off" },
	{ name: "cost", values: ["on", "off"], description: "show or hide token cost" },
	{ name: "buttons", values: ["on", "off"], description: "enable or disable Discord buttons" },
	{ name: "config", description: "show the configuration overview" },
	{ name: "help", description: "show this help" },
];

export interface DiscordPresencePrefs {
	privacyMode?: PresencePrivacyMode;
	enabled?: boolean;
	showCost?: boolean;
	buttons?: boolean;
	largeImage?: string;
	smallImages?: string;
}

export async function readPrefs(filePath = DEFAULT_PREFS_PATH): Promise<DiscordPresencePrefs> {
	const record = asRecord(readJsonFile(filePath));
	if (!record) return {};
	const prefs = { ...record } as DiscordPresencePrefs;
	// Drop an unknown mode so the env/default applies; map legacy "developer".
	const privacyMode = normalizePrivacyMode(record.privacyMode);
	if (privacyMode) prefs.privacyMode = privacyMode;
	else delete prefs.privacyMode;
	return prefs;
}

export async function writePrefs(
	prefs: DiscordPresencePrefs,
	filePath = DEFAULT_PREFS_PATH,
): Promise<void> {
	try {
		await writeJsonFile(filePath, prefs);
	} catch {
		// Non-fatal if the filesystem is read-only
	}
}

/**
 * A presence on/off switch: on unless the env variable holds an off value
 * (`off`, `false`, `0`, `no`, `disable[d]`) or the saved preference is false.
 */
export function presenceSwitch(envName: string, pref: boolean | undefined): boolean {
	return parseOnOff(process.env[envName] ?? "") !== false && pref !== false;
}

/**
 * The thinking level shown next to the model: reasoning models always show one
 * (`off` when disabled); other models show it only when explicitly enabled.
 */
export function displayThinkingLevel(
	model: Parameters<typeof isReasoningSupported>[0],
	level: string | undefined,
): string | undefined {
	if (isReasoningSupported(model)) return level || "off";
	return level && level !== "off" ? level : undefined;
}

/** Return a basename for both POSIX and Windows paths, regardless of host OS. */
export function basenameForAnyPlatform(value: string): string {
	const normalized = value.trim().replace(/[\\/]+$/, "");
	if (!normalized) return "project";
	const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	return normalized.slice(separator + 1) || "project";
}

export function parseClientId(value: string | undefined): string | undefined {
	const clientId = value?.trim();
	return clientId && /^\d{17,20}$/.test(clientId) ? clientId : undefined;
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

/** State projected onto the bare-`/discord` menu screens. */
interface DiscordMenuState {
	enabled: boolean;
	privacy: PresencePrivacyMode;
	showCost: boolean;
	buttons: boolean;
	status: string;
	config: string;
	diagnostics: string;
	costOverride: boolean;
	buttonsOverride: boolean;
}

export default function registerDiscordPresenceExtension(pi: ExtensionAPI): void {
	if (isSubagentEnvironment()) {
		return;
	}
	let manager: DiscordPresenceManager | undefined;
	let subagentTracker: SubagentTracker | undefined;
	let disabledReason: string | undefined;
	let agentActive = false;
	const activeTools = new Map<string, PresenceAction>();
	let anonymousToolCounter = 0;

	type DiscordCmdCtx = Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1];

	/** Diagnostics text shared by `/discord status` and the settings menu. */
	async function buildStatusText(): Promise<string> {
		let text = manager
			? await manager.getDiagnosticText()
			: `Discord presence: ${disabledReason ?? "not started"}`;
		if (subagentTracker?.isInstalled()) {
			text += `\nSubagents integration: active (${subagentTracker.getTotalActiveCount()} running)`;
		}
		return text;
	}

	async function handleStatus(ctx: DiscordCmdCtx): Promise<void> {
		ctx.ui.notify(
			await buildStatusText(),
			manager?.getStatus() === "connected" ? "info" : "warning",
		);
	}

	async function handlePrivacy(
		arg: string,
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	) {
		const normalized = arg.trim().toLowerCase();
		let nextMode: PresencePrivacyMode;
		if (normalized) {
			const parsed = parseMode(normalized, PRIVACY_MODES);
			if (!parsed) {
				ctx.ui.notify(unknownMode(arg, PRIVACY_MODES), "warning");
				return;
			}
			nextMode = parsed;
		} else {
			nextMode = cycleMode(manager?.getPrivacyMode() ?? "strict", PRIVACY_MODES);
		}

		const prefs = await readPrefs();
		prefs.privacyMode = nextMode;
		await writePrefs(prefs);

		if (manager) {
			await manager.setPrivacyMode(nextMode);
		}

		ctx.ui.notify(`Discord Presence privacy mode set to "${nextMode}" (saved).`, "info");
	}

	async function handleToggle(
		arg: string,
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	) {
		const prefs = await readPrefs();
		const currentEnabled = prefs.enabled !== false;
		const normalized = arg.trim().toLowerCase();
		const parsed = parseOnOff(normalized);
		if (normalized.length > 0 && parsed === undefined) {
			ctx.ui.notify(unknownMode(arg, ["on", "off"]), "warning");
			return;
		}
		const nextEnabled = parsed ?? !currentEnabled;

		prefs.enabled = nextEnabled;
		await writePrefs(prefs);

		if (nextEnabled) {
			if (manager) {
				void manager.start();
				ctx.ui.notify("Discord Presence enabled and running.", "info");
			} else {
				ctx.ui.notify("Discord Presence enabled. Reload or restart session to activate.", "info");
			}
		} else {
			if (manager) {
				await manager.stop();
			}
			ctx.ui.notify("Discord Presence disabled (/discord toggle on to resume).", "info");
		}
	}

	/** Configuration overview shared by `/discord config` and the settings menu. */
	async function buildConfigText(): Promise<string> {
		const prefs = await readPrefs();
		const configuredClientId = process.env[CLIENT_ID_ENV];
		const clientId = configuredClientId ?? DEFAULT_CLIENT_ID;
		const isDefaultClient = clientId === DEFAULT_CLIENT_ID;
		const privacy =
			manager?.getPrivacyMode() ?? prefs.privacyMode ?? parsePrivacyMode(process.env[PRIVACY_ENV]);
		const enabled = prefs.enabled !== false;
		const showCost = presenceSwitch(SHOW_COST_ENV, prefs.showCost);
		const transportMode = resolveDiscordTransportMode();
		const buttons = presenceSwitch(BUTTONS_ENV, prefs.buttons);
		const largeImage =
			process.env[LARGE_IMAGE_ENV] ?? prefs.largeImage ?? (isDefaultClient ? "pi" : "(none)");
		const smallImages =
			process.env[SMALL_IMAGES_ENV] ??
			prefs.smallImages ??
			(isDefaultClient ? "action badge" : "(none)");

		const lines = [
			"Discord Rich Presence configuration",
			`status: ${manager?.getStatusText() ?? disabledReason ?? (enabled ? "ready" : "disabled")}`,
			`transport: ${transportMode}`,
			`privacy: ${privacy}`,
			`cost: ${showCost ? "shown" : "hidden"}`,
			`client ID: ${clientId} (${isDefaultClient ? "default" : "custom"})`,
			`buttons: ${buttons ? "enabled" : "disabled"}`,
			`large image: ${largeImage}`,
			`small images: ${smallImages}`,
			`subagents: ${subagentTracker?.isInstalled() ? `detected (${subagentTracker.getTotalActiveCount()} running)` : "not detected"}`,
			`preferences: ${DEFAULT_PREFS_PATH}`,
		];
		return lines.join("\n");
	}

	async function handleConfig(ctx: DiscordCmdCtx): Promise<void> {
		await showText(ctx, "Discord presence — configuration", await buildConfigText());
	}

	/** `/discord cost [on|off]` — show or hide token cost in the presence. */
	async function handleCost(arg: string, ctx: DiscordCmdCtx): Promise<void> {
		const prefs = await readPrefs();
		const normalized = arg.trim().toLowerCase();
		const parsed = parseOnOff(normalized);
		if (normalized.length > 0 && parsed === undefined) {
			ctx.ui.notify(unknownMode(arg, ["on", "off"]), "warning");
			return;
		}
		const next = parsed ?? !presenceSwitch(SHOW_COST_ENV, prefs.showCost);
		prefs.showCost = next;
		await writePrefs(prefs);
		if (manager) await manager.setShowCost(next);
		ctx.ui.notify(
			`Discord Presence cost display ${next ? "enabled" : "disabled"} (saved).`,
			"info",
		);
	}

	/** `/discord buttons [on|off]` — enable or disable Discord buttons. */
	async function handleButtons(arg: string, ctx: DiscordCmdCtx): Promise<void> {
		const prefs = await readPrefs();
		const normalized = arg.trim().toLowerCase();
		const parsed = parseOnOff(normalized);
		if (normalized.length > 0 && parsed === undefined) {
			ctx.ui.notify(unknownMode(arg, ["on", "off"]), "warning");
			return;
		}
		const next = parsed ?? !presenceSwitch(BUTTONS_ENV, prefs.buttons);
		prefs.buttons = next;
		await writePrefs(prefs);
		if (manager) await manager.setEnableButtons(next);
		ctx.ui.notify(`Discord Presence buttons ${next ? "enabled" : "disabled"} (saved).`, "info");
	}

	/** Bare `/discord`: the /goal-style menu with status, configuration, and settings. */
	async function showDiscordMenu(ctx: DiscordCmdCtx): Promise<void> {
		type Screen = "main" | "settings" | "status" | "config";
		type Action = "set-enabled" | "set-privacy" | "set-cost" | "set-buttons";
		await showExtensionMenu<DiscordMenuState, Screen, Action>(
			ctx,
			(kit) =>
				kit.defineMenu<DiscordMenuState, Screen, Action>({
					start: "main",
					screens: {
						main: ({ state }) => ({
							kind: "actions",
							title: "Discord Rich Presence",
							lines: [
								`Status: ${state.status}`,
								`Privacy: ${state.privacy}`,
								`Cost: ${state.showCost ? "shown" : "hidden"}`,
							],
							items: [
								{ id: "status", label: "Status & diagnostics", to: "status" },
								{ id: "config", label: "Configuration", to: "config" },
								{ id: "settings", label: "Settings", to: "settings" },
								{ id: "close", label: "Close", close: true },
							],
							hint: "close",
						}),
						settings: ({ state }) => ({
							kind: "settings",
							title: "Discord Rich Presence settings",
							lines: [`Preferences · ${DEFAULT_PREFS_PATH}`],
							items: [
								{
									id: "enabled",
									label: "Presence",
									description: "Publish Rich Presence for active Pi sessions.",
									currentValue: state.enabled ? "On" : "Off",
									values: ["On", "Off"],
									action: "set-enabled",
								},
								{
									id: "privacy",
									label: "Privacy mode",
									description:
										"Strict hides project and usage details; project shows the project name.",
									currentValue: state.privacy === "strict" ? "Strict" : "Project",
									values: ["Strict", "Project"],
									action: "set-privacy",
								},
								{
									id: "cost",
									label: "Cost display",
									description: state.costOverride
										? `Saved preference; ${SHOW_COST_ENV} currently overrides it.`
										: "Show token cost in the presence.",
									currentValue: state.showCost ? "Shown" : "Hidden",
									values: ["Shown", "Hidden"],
									action: "set-cost",
								},
								{
									id: "buttons",
									label: "Discord buttons",
									description: state.buttonsOverride
										? `Saved preference; ${BUTTONS_ENV} currently overrides it.`
										: "Add Discord profile buttons to the presence.",
									currentValue: state.buttons ? "Enabled" : "Disabled",
									values: ["Enabled", "Disabled"],
									action: "set-buttons",
								},
							],
						}),
						status: ({ state }) => ({
							kind: "detail",
							title: "Discord Rich Presence — status",
							lines: state.diagnostics.split("\n"),
							hint: "back",
						}),
						config: ({ state }) => ({
							kind: "detail",
							title: "Discord Rich Presence — configuration",
							lines: state.config.split("\n"),
							hint: "back",
						}),
					},
					actions: {
						"set-enabled": async ({ value, ctx: menuCtx }) => {
							if (value) await handleToggle(value, menuCtx);
							return { kind: "stay" };
						},
						"set-privacy": async ({ value, ctx: menuCtx }) => {
							if (value) await handlePrivacy(value, menuCtx);
							return { kind: "stay" };
						},
						"set-cost": async ({ value, ctx: menuCtx }) => {
							await handleCost(value === "Shown" ? "on" : "off", menuCtx);
							return { kind: "stay" };
						},
						"set-buttons": async ({ value, ctx: menuCtx }) => {
							if (value) await handleButtons(value, menuCtx);
							return { kind: "stay" };
						},
					},
				}),
			{
				getState: async () => {
					const prefs = await readPrefs();
					const enabled = prefs.enabled !== false;
					return {
						enabled,
						privacy:
							manager?.getPrivacyMode() ??
							prefs.privacyMode ??
							parsePrivacyMode(process.env[PRIVACY_ENV]),
						showCost: presenceSwitch(SHOW_COST_ENV, prefs.showCost),
						buttons: presenceSwitch(BUTTONS_ENV, prefs.buttons),
						status: manager?.getStatusText() ?? disabledReason ?? (enabled ? "ready" : "disabled"),
						config: await buildConfigText(),
						diagnostics: await buildStatusText(),
						costOverride: parseOnOff(process.env[SHOW_COST_ENV] ?? "") !== undefined,
						buttonsOverride: parseOnOff(process.env[BUTTONS_ENV] ?? "") !== undefined,
					};
				},
			},
		);
	}

	// Unified /discord command
	pi.registerCommand("discord", {
		description:
			"Manage Discord Rich Presence (/discord status | privacy | toggle | cost | buttons | config)",
		getArgumentCompletions: (prefix) => argumentCompletions(DISCORD_SPECS, prefix),
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);

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
				case "help": {
					const helpPrefs = await readPrefs();
					await showHelp(
						ctx,
						commandHelp({
							title: "Discord presence",
							command: "/discord",
							specs: DISCORD_SPECS,
							sections: [
								{
									heading: "Settings",
									lines: [
										`privacy: ${manager?.getPrivacyMode() ?? "strict"}`,
										`enabled: ${helpPrefs.enabled === false ? "no" : "yes"}`,
										`cost: ${presenceSwitch(SHOW_COST_ENV, helpPrefs.showCost) ? "shown" : "hidden"}`,
										`buttons: ${presenceSwitch(BUTTONS_ENV, helpPrefs.buttons) ? "enabled" : "disabled"}`,
										`preferences: ${DEFAULT_PREFS_PATH}`,
									],
								},
							],
						}),
					);
					break;
				}
				case "":
					if (menuSupported(ctx)) {
						await showDiscordMenu(ctx);
						return;
					}
					await handleConfig(ctx);
					break;
				default:
					ctx.ui.notify(unknownSubcommand("/discord", sub, DISCORD_SPECS), "warning");
					break;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (isSubagentSession(ctx)) {
			disabledReason = "disabled: subagent session";
			return;
		}
		const sessionStartedAt = Date.now();
		subagentTracker?.dispose();
		subagentTracker = undefined;
		if (manager) await manager.stop();
		manager = undefined;
		disabledReason = undefined;
		agentActive = false;
		activeTools.clear();
		anonymousToolCounter = 0;

		const prefs = await readPrefs();
		if (prefs.enabled === false) {
			disabledReason = "disabled via /discord toggle (preferences)";
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

		const privacyMode = prefs.privacyMode ?? parsePrivacyMode(process.env[PRIVACY_ENV]);
		const showCost = presenceSwitch(SHOW_COST_ENV, prefs.showCost);
		const enableButtons = presenceSwitch(BUTTONS_ENV, prefs.buttons);

		const thinkingLevel = displayThinkingLevel(
			ctx.model,
			ctx.thinkingLevel ?? pi.getThinkingLevel?.(),
		);

		manager = new DiscordPresenceManager({
			clientId,
			projectName,
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			thinkingLevel,
			startedAt: sessionStartedAt,
			initialUsage,
			initialContext,
			privacyMode,
			readPrivacyMode: async () =>
				(await readPrefs()).privacyMode ?? parsePrivacyMode(process.env[PRIVACY_ENV]),
			showCost,
			enableButtons,
			largeImageKey: process.env[LARGE_IMAGE_ENV] ?? prefs.largeImage,
			smallImageKey: process.env[SMALL_IMAGES_ENV] ?? prefs.smallImages,
		});
		void manager.start();

		const sessionManagerId =
			ctx.sessionManager?.getSessionFile?.() ??
			ctx.sessionManager?.getSessionId?.() ??
			manager.getSessionId();

		subagentTracker = new SubagentTracker({
			events: pi.events,
			sessionId: sessionManagerId,
			onCountChange: async (count) => {
				await manager?.setActiveSubagents(count);
			},
		});

		if (pi.getAllTools?.().some((t) => t.name === "subagent")) {
			subagentTracker.markInstalled();
			subagentTracker.queryRpcStatus();
		}
	});

	pi.on("model_select", async (event, ctx) => {
		const thinkingLevel = displayThinkingLevel(
			event.model,
			ctx.thinkingLevel ?? pi.getThinkingLevel?.(),
		);
		await manager?.setModel(event.model.provider, event.model.id, thinkingLevel);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await manager?.setThinkingLevel(displayThinkingLevel(ctx.model, event.level));
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
		const callId = event?.toolCallId ?? `anon-${++anonymousToolCounter}`;
		subagentTracker?.onToolExecutionStart(callId, event?.toolName);
		const action = classifyToolAction(event?.toolName);
		activeTools.set(callId, action);
		const currentAction = pickHighestPriorityAction(activeTools.values());
		await manager?.setPhase("tools", currentAction);
	});

	pi.on("tool_execution_end", async (event) => {
		if (event?.toolCallId && activeTools.has(event.toolCallId)) {
			subagentTracker?.onToolExecutionEnd(event.toolCallId);
			activeTools.delete(event.toolCallId);
		} else if (activeTools.size > 0) {
			const firstKey = activeTools.keys().next().value;
			if (firstKey !== undefined) {
				subagentTracker?.onToolExecutionEnd(firstKey);
				activeTools.delete(firstKey);
			}
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
		subagentTracker?.queryRpcStatus();
		await manager?.setPhase("idle", "idle");
		await manager?.setContextUsage(normalizeContextUsage(ctx.getContextUsage()));
	});

	pi.on("session_shutdown", async () => {
		subagentTracker?.dispose();
		subagentTracker = undefined;
		await manager?.stop();
		manager = undefined;
		agentActive = false;
		activeTools.clear();
		anonymousToolCounter = 0;
	});
}
