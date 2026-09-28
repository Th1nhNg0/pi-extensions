/** Presence privacy policy, activity formatting, ordering, and Discord payload construction. */
import type { SetActivity } from "@xhayper/discord-rpc";
import {
	ACTION_BADGE_URLS,
	formatAction,
	type PresenceAction,
	type PresencePhase,
} from "./actions.ts";
import { formatDiscordModelLabel, truncateText } from "./model-labels.ts";
import { emptyUsageTotals, isSubagentRecord } from "./session-state.ts";
import type {
	ContextSnapshot,
	PresenceState,
	SessionRecord,
	UsageTotals,
} from "./session-state.ts";
import { formatCost, formatTokenCount, summarizeRecords } from "./session-usage.ts";
import type { AggregateSummary } from "./session-usage.ts";

export const BUTTONS_ENV = "PI_DISCORD_BUTTONS";
export const LARGE_IMAGE_ENV = "PI_DISCORD_LARGE_IMAGE";
export const SMALL_IMAGES_ENV = "PI_DISCORD_SMALL_IMAGES";

export const DEFAULT_CLIENT_ID = "1541350417143955466";
export const DEFAULT_LARGE_IMAGE_KEY =
	"https://cdn.discordapp.com/app-icons/1541350417143955466/71bb55a3b54d84642419948a680f22e4.png";
export const DEFAULT_LARGE_IMAGE_TEXT = "Pi Coding Agent";

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

export type PresencePrivacyMode = "strict" | "project";
export const PRIVACY_MODES: readonly PresencePrivacyMode[] = ["strict", "project"];

export type PresenceActivity = SetActivity & {
	details: string;
	state: string;
	startTimestamp: number;
	instance: true;
};

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

/**
 * A known privacy mode, or undefined. The retired `developer` mode showed
 * exactly what `project` shows, so saved prefs and env values using it keep
 * working as `project`.
 */
export function normalizePrivacyMode(value: unknown): PresencePrivacyMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "strict") return "strict";
	if (normalized === "project" || normalized === "developer") return "project";
	return undefined;
}

export function parsePrivacyMode(value: string | undefined): PresencePrivacyMode {
	return normalizePrivacyMode(value) ?? "strict";
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
		const clampedPercent = Math.min(100, Math.max(0, Math.round(context.percent)));
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
	const actionText = formatAction(record.action, record.phase, record.activeSubagents ?? 0);
	const modelText = formatDiscordModelLabel(record.provider, record.modelId, record.thinkingLevel);
	return truncateText(`${actionText} · ${modelText}`);
}

export function formatSingleSessionState(
	record: SessionRecord,
	privacy: PresencePrivacyMode = "strict",
	showCost = true,
): string {
	const metrics = formatPublicMetrics(record.usage, record.context, privacy, showCost);
	if (privacy === "project") {
		const project = truncateText(record.projectName || "project", 48);
		return truncateText(`${project} · ${metrics}`);
	}
	return truncateText(metrics);
}

export function summarizeModels(records: readonly SessionRecord[]): string {
	if (records.length === 0) return "Pi";
	const labels = new Set(
		records.map((r) => formatDiscordModelLabel(r.provider, r.modelId, r.thinkingLevel)),
	);
	if (labels.size === 1) return labels.values().next().value ?? "Pi";
	return "multiple models";
}

export function formatMultiSessionDetails(
	summary: AggregateSummary,
	sessionCount: number,
	showCost = true,
): string {
	const costPart =
		showCost && summary.usage.cost !== undefined ? ` · ${formatCost(summary.usage)}` : "";
	return truncateText(
		`${sessionCount} Pi sessions · ${formatTokenCount(summary.usage.total)} tok${costPart}`,
	);
}

export function formatMultiSessionState(
	records: readonly SessionRecord[],
	projectCount: number,
	subagentCount = 0,
): string {
	const activeCount = records.filter(
		(r) => r.phase !== "idle" || (r.activeSubagents ?? 0) > 0,
	).length;
	let activeLabel: string;
	if (activeCount === 0) {
		activeLabel = `${records.length} idle`;
	} else if (subagentCount > 0) {
		activeLabel = `${activeCount} active (${subagentCount} subagent${subagentCount === 1 ? "" : "s"})`;
	} else {
		activeLabel = `${activeCount} active`;
	}
	const modelLabel = summarizeModels(records);
	const projectLabel = `${projectCount} project${projectCount === 1 ? "" : "s"}`;
	return truncateText(`${activeLabel} · ${modelLabel} · ${projectLabel}`);
}

export function attachAssetsAndButtons(
	activity: SetActivity,
	action?: PresenceAction,
	phase: PresencePhase = "idle",
	options: ActivityBuildOptions = {},
	subagents = 0,
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
		let effectiveAction = action ?? (phase === "tools" ? "tools" : phase);
		if (subagents > 0 && (phase === "idle" || effectiveAction === "idle")) {
			effectiveAction = "subagents";
		}
		let smallKey: string = ACTION_BADGE_URLS[effectiveAction] ?? ACTION_BADGE_URLS.tools;
		if (
			smallImagesEnv &&
			smallImagesEnv !== "on" &&
			smallImagesEnv !== "true" &&
			smallImagesEnv !== "1" &&
			smallImagesEnv !== "auto"
		) {
			smallKey = smallImagesEnv;
		}

		const smallText = options.smallImageText ?? formatAction(effectiveAction, phase, subagents);

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

	attachAssetsAndButtons(
		activity,
		record.action,
		record.phase,
		options,
		record.activeSubagents ?? 0,
	);
	return activity;
}

export function buildMultiSessionActivity(
	state: PresenceState,
	options: ActivityBuildOptions = {},
	orderedRecords?: SessionRecord[],
): PresenceActivity {
	const records = orderedRecords ?? orderedSessions(state);
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
	const activityState = formatMultiSessionState(
		records,
		summary.projectCount,
		summary.subagentCount,
	);

	const activity: PresenceActivity = {
		details,
		state: activityState,
		startTimestamp: summary.startTimestamp,
		instance: true,
	};

	attachAssetsAndButtons(
		activity,
		primary.action,
		primary.phase,
		options,
		primary.activeSubagents ?? 0,
	);
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
			startTimestamp: state.updatedAt || Date.now(),
			instance: true,
		};
	}
	if (records.length === 1) {
		return buildSingleSessionActivity(records[0], options);
	}
	return buildMultiSessionActivity(state, options, records);
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
		a.startedAt - b.startedAt ||
		b.lastSeenAt - a.lastSeenAt ||
		a.sessionId.localeCompare(b.sessionId)
	);
}

export function isActivityEqual(a?: PresenceActivity, b?: PresenceActivity): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (
		a.details !== b.details ||
		a.state !== b.state ||
		a.startTimestamp !== b.startTimestamp ||
		a.endTimestamp !== b.endTimestamp ||
		a.largeImageKey !== b.largeImageKey ||
		a.largeImageUrl !== b.largeImageUrl ||
		a.largeImageText !== b.largeImageText ||
		a.smallImageKey !== b.smallImageKey ||
		a.smallImageUrl !== b.smallImageUrl ||
		a.smallImageText !== b.smallImageText ||
		a.instance !== b.instance
	) {
		return false;
	}
	const aButtons = a.buttons;
	const bButtons = b.buttons;
	if (aButtons === bButtons) return true;
	if (!aButtons || !bButtons) return false;
	if (aButtons.length !== bButtons.length) return false;
	for (let i = 0; i < aButtons.length; i++) {
		if (aButtons[i]?.label !== bButtons[i]?.label || aButtons[i]?.url !== bButtons[i]?.url) {
			return false;
		}
	}
	return true;
}

export function orderedSessions(state: PresenceState): SessionRecord[] {
	const records = Object.values(state.sessions).filter((r) => !isSubagentRecord(r));
	const publisher = state.publisherId ? state.sessions[state.publisherId] : undefined;
	return records.sort((a, b) => {
		const aActive = a.phase !== "idle" || (a.activeSubagents ?? 0) > 0;
		const bActive = b.phase !== "idle" || (b.activeSubagents ?? 0) > 0;
		if (aActive !== bActive) return aActive ? -1 : 1;
		if (publisher && !isSubagentRecord(publisher)) {
			if (a.sessionId === publisher.sessionId) return -1;
			if (b.sessionId === publisher.sessionId) return 1;
		}
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
