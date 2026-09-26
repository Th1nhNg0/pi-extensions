/** Action vocabulary, tool classification, human labels, and per-action badge assets. */

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
	| "subagents"
	| "idle";

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
	subagents: "#a78bfa",
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
	subagents: "robot",
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
	subagents = 0,
): string {
	const effectiveAction = action ?? (phase === "tools" ? "tools" : phase);
	if (subagents > 0) {
		if (
			phase === "idle" ||
			effectiveAction === "idle" ||
			effectiveAction === "subagents"
		) {
			return `${subagents} subagent${subagents === 1 ? "" : "s"} running`;
		}
		return `${formatActionName(effectiveAction, phase)} (${subagents} subagent${subagents === 1 ? "" : "s"})`;
	}
	return formatActionName(effectiveAction, phase);
}

function formatActionName(
	effectiveAction: PresenceAction,
	phase: PresencePhase = "idle",
): string {
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
		case "subagents":
			return "Running subagents";
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

	// Subagent delegation tools
	if (
		normalized === "subagent" ||
		normalized.includes("subagent") ||
		normalized.includes("sub agent")
	) {
		return "subagents";
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
	subagents: 1.5,
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
