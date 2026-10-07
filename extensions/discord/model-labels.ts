/** Model capability and user-facing model-label formatting for Discord presence. */

const MAX_ACTIVITY_TEXT_LENGTH = 128;
export function truncateText(value: string, maxLength = MAX_ACTIVITY_TEXT_LENGTH): string {
	const safeValue = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from activity text
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(safeValue);
	if (characters.length <= maxLength) return safeValue;
	return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

/** Determine whether a model supports reasoning/thinking mode. */
export function isReasoningSupported(model?: {
	reasoning?: boolean;
	thinkingLevelMap?: unknown;
	id?: string;
}): boolean {
	if (!model) return false;
	if (typeof model.reasoning === "boolean") return model.reasoning;
	if (model.thinkingLevelMap && typeof model.thinkingLevelMap === "object") {
		return Object.keys(model.thinkingLevelMap).length > 0;
	}
	const id = model.id?.toLowerCase() ?? "";
	if (
		id.includes("claude-3-7") ||
		id.includes("claude-4") ||
		id.includes("claude-opus") ||
		id.includes("claude-sonnet") ||
		id.startsWith("o1") ||
		id.startsWith("o3") ||
		id.startsWith("o4") ||
		id.includes("gemini-2.5-pro") ||
		id.includes("deepseek-r1")
	) {
		return true;
	}
	return false;
}

/** Diagnostic full model label (e.g. `openai-codex/gpt-5` or `openai-codex/gpt-5 (high)`). */
export function formatModelLabel(
	provider?: string,
	modelId?: string,
	thinkingLevel?: string,
): string {
	const base = provider && modelId ? `${provider}/${modelId}` : (modelId ?? provider ?? "Pi");
	const effectiveThinking = thinkingLevel?.trim().toLowerCase();
	const label = effectiveThinking ? `${base} (${effectiveThinking})` : base;
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

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Human-readable model label for Discord Rich Presence. */
export function formatDiscordModelLabel(
	provider?: string,
	modelId?: string,
	thinkingLevel?: string,
): string {
	let effectiveThinking = thinkingLevel?.trim().toLowerCase();

	if (!modelId?.trim()) {
		const baseLabel = !provider?.trim() ? "Pi" : formatProviderFallback(provider);
		if (effectiveThinking) {
			return truncateText(`${baseLabel} (${effectiveThinking})`, 48);
		}
		return baseLabel;
	}

	let raw = modelId.trim();
	if (raw.includes("/")) {
		raw = raw.slice(raw.lastIndexOf("/") + 1).trim();
	}

	// Extract inline thinking level if present (e.g. claude-3-7-sonnet:high)
	const colonIndex = raw.lastIndexOf(":");
	if (colonIndex > 0) {
		const suffix = raw.slice(colonIndex + 1).toLowerCase();
		if (VALID_THINKING_LEVELS.has(suffix)) {
			if (!effectiveThinking) {
				effectiveThinking = suffix;
			}
			raw = raw.slice(0, colonIndex);
		}
	}

	let baseLabel = "";
	// Preserve openai o-series models (e.g. o1, o3, o3-mini, o4-mini, o1-preview)
	if (/^o\d(-[a-z0-9]+)?$/i.test(raw)) {
		baseLabel = raw.toLowerCase();
	} else {
		// Convert version numbers separated by dashes (e.g. 4-1 -> 4.1, 3-7 -> 3.7, 2-5 -> 2.5)
		const transformed = raw.replace(/(?<=[a-zA-Z]|^)-(\d+)-(\d+)(?=-|[a-zA-Z]|$)/g, "-$1.$2");

		let matched = false;
		for (const [pattern, prefix] of KNOWN_PREFIXES) {
			if (pattern.test(transformed)) {
				const rest = transformed.replace(pattern, "");
				if (prefix.endsWith("-")) {
					baseLabel = `${prefix}${formatModelWords(rest, false)}`;
				} else {
					baseLabel = `${prefix}${formatModelWords(rest, true)}`;
				}
				matched = true;
				break;
			}
		}

		if (!matched) {
			baseLabel = formatModelWords(transformed, true);
		}
	}

	if (effectiveThinking) {
		return truncateText(`${baseLabel} (${effectiveThinking})`, 48);
	}
	return truncateText(baseLabel, 48);
}
