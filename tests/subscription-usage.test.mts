import assert from "node:assert/strict";
import test from "node:test";
import {
	bar,
	cap,
	codexCfg,
	normalizeUsageData,
	normalizePrefs,
	normalizeUsageMode,
	normalizeUsageStyle,
	codexWindowKey,
	earliestReset,
	parseCodexUsage,
	resetLabel,
	windowSegment,
	type CodexUsageResponse,
	type UsageData,
} from "../extensions/subscription-usage.ts";

const mockTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

test("cap capitalizes strings", () => {
	assert.equal(cap("plus"), "Plus");
	assert.equal(cap("pro"), "Pro");
	assert.equal(cap("team"), "Team");
	assert.equal(cap(""), "");
});

test("usage payload normalization clamps percentages and drops malformed data", () => {
	assert.deepEqual(
		normalizeUsageData({
			windows: { high: 150, low: -10, okay: 42.5, invalid: Number.NaN },
			plan: "  plus  ",
			resets: { okay: 1_000, invalid: Number.NaN },
		}),
		{
			windows: { high: 100, low: 0, okay: 42.5 },
			plan: "plus",
			resets: { okay: 1_000 },
		},
	);
	assert.equal(
		normalizeUsageData({ windows: { invalid: Number.NaN } }),
		undefined,
	);
	assert.equal(normalizeUsageData([]), undefined);
});

test("resetLabel formats countdowns correctly", () => {
	const now = 1_000_000;
	assert.equal(resetLabel(now + 30_000, now), "~<1m");
	assert.equal(resetLabel(now + 60_000, now), "~<1m");
	assert.equal(resetLabel(now + 5 * 60_000, now), "~5m");
	assert.equal(resetLabel(now + 4 * 3600_000, now), "~4h");
	assert.equal(resetLabel(now + 3 * 86400_000, now), "~3d");
	assert.equal(resetLabel(now + 14 * 86400_000, now), "~14d");
	assert.equal(resetLabel(now + 35 * 86400_000, now), "~5w");
	assert.equal(resetLabel(Number.NaN, now), "~?");
});

test("codexWindowKey classifies window durations", () => {
	assert.equal(codexWindowKey({ limit_window_seconds: 18_000 }), "5h");
	assert.equal(codexWindowKey({ limit_window_seconds: 86_400 }), "daily");
	assert.equal(codexWindowKey({ limit_window_seconds: 604_800 }), "weekly");
	assert.equal(codexWindowKey({ limit_window_seconds: 2_592_000 }), "monthly");
	assert.equal(codexWindowKey({ limit_window_seconds: 7_200 }), "2h");
	assert.equal(codexWindowKey({}, "fallback-key"), "fallback-key");
	assert.equal(
		codexWindowKey({ limit_window_seconds: 0 }, "fallback-key"),
		"fallback-key",
	);
});

test("parseCodexUsage parses dual-window response (5h + weekly)", () => {
	const response: CodexUsageResponse = {
		plan_type: "plus",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 1,
				limit_window_seconds: 18000,
				reset_after_seconds: 17569,
				reset_at: 1787727518,
			},
			secondary_window: {
				used_percent: 45,
				limit_window_seconds: 604800,
				reset_after_seconds: 604369,
				reset_at: 1788314318,
			},
		},
	};

	const parsed = parseCodexUsage(response);
	assert.equal(parsed.plan, "plus");
	assert.deepEqual(parsed.windows, {
		"5h": 1,
		weekly: 45,
	});
	assert.deepEqual(parsed.resets, {
		"5h": 1787727518000,
		weekly: 1788314318000,
	});
});

test("parseCodexUsage handles single weekly window response", () => {
	const response: CodexUsageResponse = {
		plan_type: "team",
		rate_limit: {
			primary_window: {
				used_percent: 25,
				limit_window_seconds: 604800,
				reset_at: 1788314318,
			},
		},
	};

	const parsed = parseCodexUsage(response);
	assert.equal(parsed.plan, "team");
	assert.deepEqual(parsed.windows, {
		weekly: 25,
	});
	assert.deepEqual(parsed.resets, {
		weekly: 1788314318000,
	});
});

test("parseCodexUsage handles windows missing limit_window_seconds", () => {
	const response: CodexUsageResponse = {
		plan_type: "pro",
		rate_limit: {
			primary_window: {
				used_percent: 10,
				reset_at: 1000,
			},
			secondary_window: {
				used_percent: 60,
				reset_at: 5000,
			},
		},
	};

	const parsed = parseCodexUsage(response);
	assert.equal(parsed.plan, "pro");
	assert.deepEqual(parsed.windows, {
		"5h": 10,
		weekly: 60,
	});
});

test("parseCodexUsage throws on empty response", () => {
	assert.throws(() => parseCodexUsage({}), /no usage data/);
});

test("codexCfg.render renders windows without a provider prefix", () => {
	const data: UsageData = {
		plan: "plus",
		windows: {
			"5h": 5,
			weekly: 50,
		},
		resets: {
			"5h": 1_000_000 + 4 * 3600_000,
			weekly: 1_000_000 + 3 * 86400_000,
		},
	};

	// Bars (default): `5h: <bar> · W: <bar>` (resets long past → ~<1m)
	const rendered = codexCfg.render(data, mockTheme);
	assert.match(rendered, /^5h:\s+░░░░░░\s+5% ~<1m · W: ███░░░\s+50% ~<1m$/);
	assert.doesNotMatch(rendered, /Codex|plus/i);

	// Percent style: bare colorized percentages with countdowns.
	assert.equal(
		codexCfg.render(data, mockTheme, undefined, "percent"),
		"5h 5% ~<1m · W 50% ~<1m",
	);
});

test("codexCfg.render handles weekly-only window", () => {
	const data: UsageData = {
		plan: "team",
		windows: {
			weekly: 75,
		},
		resets: {
			weekly: 1_000_000 + 2 * 86400_000,
		},
	};

	const rendered = codexCfg.render(data, mockTheme);
	assert.match(rendered, /^W: █████░\s+75%/);
	assert.doesNotMatch(rendered, /5h:/);
});

test("windowSegment renders bars and percent styles", () => {
	const resets = { k: 1_000_000 + 120_000 };
	const now = 1_000_000;
	assert.match(
		windowSegment(50, resets, "k", mockTheme, "bars", now),
		/███░░░\s+50% ~2m/,
	);
	assert.equal(
		windowSegment(50, resets, "k", mockTheme, "percent", now),
		"50% ~2m",
	);
});

test("normalizeUsageStyle/Mode/Prefs validate input", () => {
	assert.equal(normalizeUsageStyle("bars"), "bars");
	assert.equal(normalizeUsageStyle("percent"), "percent");
	assert.equal(normalizeUsageStyle("fancy"), undefined);
	assert.equal(normalizeUsageStyle(undefined), undefined);

	assert.equal(normalizeUsageMode("bars"), "bars");
	assert.equal(normalizeUsageMode("percent"), "percent");
	assert.equal(normalizeUsageMode("off"), "off");
	assert.equal(normalizeUsageMode("nope"), undefined);

	assert.deepEqual(normalizePrefs({ mode: "percent" }), { mode: "percent" });
	assert.deepEqual(normalizePrefs({ mode: "off" }), { mode: "off" });
	// Legacy pre-toggle pref files carried a bare { style } field.
	assert.deepEqual(normalizePrefs({ style: "percent" }), { mode: "percent" });
	assert.deepEqual(normalizePrefs(undefined), { mode: "bars" });
	assert.deepEqual(normalizePrefs("junk"), { mode: "bars" });
	assert.deepEqual(normalizePrefs({ mode: "nope", style: 42 }), {
		mode: "bars",
	});
});

test("earliestReset selects the minimum reset timestamp across windows", () => {
	const data: UsageData = {
		windows: { "5h": 10, weekly: 20 },
		resets: {
			"5h": 1_700_000_000,
			weekly: 1_800_000_000,
		},
	};

	assert.equal(earliestReset(data), 1_700_000_000);
});

test("bar renders proper cell count and color bands", () => {
	assert.equal(bar(0, undefined, "key", mockTheme), "░░░░░░  0%");
	assert.equal(bar(50, undefined, "key", mockTheme), "███░░░  50%");
	assert.equal(bar(100, undefined, "key", mockTheme), "██████  100%");
	assert.equal(bar(150, undefined, "key", mockTheme), "██████  100%");
	assert.equal(bar(-10, undefined, "key", mockTheme), "░░░░░░  0%");
	assert.equal(bar(Number.NaN, undefined, "key", mockTheme), "░░░░░░  0%");
});
