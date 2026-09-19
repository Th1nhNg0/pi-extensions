import assert from "node:assert/strict";
import test from "node:test";
import {
	bar,
	antigravityEndpointCandidates,
	cap,
	codexCfg,
	detailBar,
	fetchAgeLabel,
	formatUsageDetails,
	normalizeUsageData,
	normalizePrefs,
	normalizeUsageMode,
	normalizeUsageStyle,
	codexWindowKey,
	earliestReset,
	parseCodexUsage,
	resetLabel,
	windowSegment,
	getDeepSeekPeakInfo,
	DEEPSEEK_PEAK_WINDOWS,
	deepseekCfg,
	resolveRefreshTargets,
	formatRefreshNotice,
	usageProviderCfgs,
	deepSeekPeakTag,
	formatBalance,
	formatDeepSeekPeakWindows,
	formatLocalTimeRange,
	usesDeepSeekPeakPricing,
	isDeepSeekPeakDay,
	antigravityCfg,
	opencodeCfg,
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
	assert.deepEqual(
		normalizeUsageData({
			windows: { okay: 10 },
			resetsLeft: 3,
		}),
		{
			windows: { okay: 10 },
			resetsLeft: 3,
		},
	);
	assert.deepEqual(
		normalizeUsageData({
			windows: { okay: 10 },
			resetsLeft: -1,
		}),
		{
			windows: { okay: 10 },
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

test("parseCodexUsage parses rate_limit_reset_credits", () => {
	const response: CodexUsageResponse = {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 6,
				limit_window_seconds: 18000,
				reset_at: 1788991060,
			},
		},
		rate_limit_reset_credits: {
			available_count: 3,
			applicable_available_count: 0,
		},
	};
	const parsed = parseCodexUsage(response);
	assert.equal(parsed.resetsLeft, 3);
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

test("codexCfg.render displays banked resets when available", () => {
	const data: UsageData = {
		plan: "plus",
		windows: { "5h": 6, weekly: 16 },
		resetsLeft: 3,
	};
	const renderedBars = codexCfg.render(data, mockTheme);
	assert.match(renderedBars, /· 3 resets left$/);

	const renderedPercent = codexCfg.render(data, mockTheme, undefined, "percent");
	assert.match(renderedPercent, /· 3 resets left$/);

	const singleReset: UsageData = {
		plan: "plus",
		windows: { "5h": 6 },
		resetsLeft: 1,
	};
	assert.match(codexCfg.render(singleReset, mockTheme), /· 1 reset left$/);

	const zeroResets: UsageData = {
		plan: "plus",
		windows: { "5h": 6 },
		resetsLeft: 0,
	};
	assert.doesNotMatch(codexCfg.render(zeroResets, mockTheme), /reset/);
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

test("antigravity endpoint candidates use the canonical daily service first", () => {
	assert.deepEqual(antigravityEndpointCandidates({}), [
		"https://daily-cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.sandbox.googleapis.com",
		"https://cloudcode-pa.googleapis.com",
	]);
	assert.deepEqual(
		antigravityEndpointCandidates({
			ANTIGRAVITY_BASE_URL: " https://example.test ",
		}),
		["https://example.test"],
	);
});

test("detailBar renders theme-free cells and clamps", () => {
	assert.equal(detailBar(0), "░░░░░░");
	assert.equal(detailBar(50), "███░░░");
	assert.equal(detailBar(100), "██████");
	assert.equal(detailBar(150), "██████");
	assert.equal(detailBar(-10), "░░░░░░");
	assert.equal(detailBar(Number.NaN), "░░░░░░");
});

test("fetchAgeLabel formats cache freshness", () => {
	const now = 1_000_000;
	assert.equal(fetchAgeLabel(now - 30_000, now), "just now");
	assert.equal(fetchAgeLabel(now - 5 * 60_000, now), "5m ago");
	assert.equal(fetchAgeLabel(now - 3 * 3600_000, now), "3h ago");
	assert.equal(fetchAgeLabel(now - 3 * 86400_000, now), "3d ago");
	assert.equal(fetchAgeLabel(Number.NaN, now), "unknown age");
});

test("formatUsageDetails lists every window with resets, plan, and freshness", () => {
	const now = Date.parse("2026-09-06T12:00:00Z");
	const text = formatUsageDetails(
		{
			windows: { weekly: 51, "5h": 12.5 },
			resets: { "5h": now + 4 * 3600_000, weekly: now + 3 * 86400_000 },
			plan: "plus",
		},
		"openai-codex",
		{ modelId: "gpt-5", fetchedAt: now - 5 * 60_000, now },
	);
	const lines = text.split("\n");
	assert.equal(lines[0], "Subscription usage — openai-codex (plus) • gpt-5");
	// Preferred order: 5h before weekly regardless of input order.
	assert.match(lines[1], /• 5h: 12\.5% .* — resets ~4h \(2026-09-06 16:00 UTC\)/);
	assert.match(lines[2], /• weekly: 51% .* — resets ~3d \(2026-09-09 12:00 UTC\)/);
	assert.equal(lines[3], "Updated 5m ago");
});

test("formatUsageDetails handles missing resets and empty data", () => {
	const text = formatUsageDetails({ windows: { rolling: 2 } }, "opencode-go", {});
	assert.match(text, /Subscription usage — opencode-go/);
	assert.match(text, /• rolling: 2% ░░░░░░/);
	assert.equal(formatUsageDetails({ windows: {} }, "openai-codex"), "openai-codex: no usage data");
});

test("formatUsageDetails lists resets left when present", () => {
	const text = formatUsageDetails(
		{
			windows: { "5h": 6, weekly: 16 },
			resetsLeft: 3,
		},
		"openai-codex",
	);
	assert.match(text, /• resets: 3 left/);

	const textZero = formatUsageDetails(
		{
			windows: { "5h": 6 },
			resetsLeft: 0,
		},
		"openai-codex",
	);
	assert.match(textZero, /• resets: 0 left/);
});

test("getDeepSeekPeakInfo accurately classifies UTC peak and off-peak windows", () => {
	// Monday 00:30 UTC -> off-peak (30m until peak window 1 at 01:00)
	const t0030 = Date.parse("2026-09-07T00:30:00.000Z");
	const info0030 = getDeepSeekPeakInfo(t0030);
	assert.equal(info0030.isPeak, false);
	assert.equal(info0030.reason, undefined);
	assert.equal(info0030.nextFlipMs, Date.parse("2026-09-07T01:00:00.000Z"));

	// 01:00 UTC -> peak window 1 starts (3h left until 04:00)
	const t0100 = Date.parse("2026-09-07T01:00:00.000Z");
	const info0100 = getDeepSeekPeakInfo(t0100);
	assert.equal(info0100.isPeak, true);
	assert.equal(info0100.nextFlipMs, Date.parse("2026-09-07T04:00:00.000Z"));

	// 04:00 UTC -> off-peak (2h until peak window 2 at 06:00)
	const t0400 = Date.parse("2026-09-07T04:00:00.000Z");
	const info0400 = getDeepSeekPeakInfo(t0400);
	assert.equal(info0400.isPeak, false);
	assert.equal(info0400.nextFlipMs, Date.parse("2026-09-07T06:00:00.000Z"));

	// 06:00 UTC -> peak window 2 starts (4h left until 10:00)
	const t0600 = Date.parse("2026-09-07T06:00:00.000Z");
	const info0600 = getDeepSeekPeakInfo(t0600);
	assert.equal(info0600.isPeak, true);
	assert.equal(info0600.nextFlipMs, Date.parse("2026-09-07T10:00:00.000Z"));

	// 10:00 UTC -> off-peak until Tuesday 01:00 UTC (15h until peak)
	const t1000 = Date.parse("2026-09-07T10:00:00.000Z");
	const info1000 = getDeepSeekPeakInfo(t1000);
	assert.equal(info1000.isPeak, false);
	assert.equal(info1000.nextFlipMs, Date.parse("2026-09-08T01:00:00.000Z"));

	// Friday 10:00 UTC runs the whole weekend through to Monday 01:00 UTC.
	const friday = getDeepSeekPeakInfo(Date.parse("2026-09-11T10:00:00.000Z"));
	assert.equal(friday.isPeak, false);
	assert.equal(friday.reason, undefined);
	assert.equal(friday.nextFlipMs, Date.parse("2026-09-14T01:00:00.000Z"));
});

test("DeepSeek peak billing skips the weekend in full", () => {
	assert.equal(isDeepSeekPeakDay(Date.parse("2026-09-05T00:00:00.000Z")), false); // Sat
	assert.equal(isDeepSeekPeakDay(Date.parse("2026-09-06T00:00:00.000Z")), false); // Sun
	assert.equal(isDeepSeekPeakDay(Date.parse("2026-09-07T00:00:00.000Z")), true); // Mon

	// A Saturday window hour stays off-peak and targets Monday's first window.
	const sat = getDeepSeekPeakInfo(Date.parse("2026-09-05T02:00:00.000Z"));
	assert.equal(sat.isPeak, false);
	assert.equal(sat.reason, "weekend");
	assert.equal(sat.windowStartMs, Date.parse("2026-09-07T01:00:00.000Z"));
	assert.equal(sat.windowEndMs, Date.parse("2026-09-07T04:00:00.000Z"));

	// Sunday keeps the weekend reason and still flips at Monday 01:00 UTC.
	const sun = getDeepSeekPeakInfo(Date.parse("2026-09-06T07:00:00.000Z"));
	assert.equal(sun.isPeak, false);
	assert.equal(sun.reason, "weekend");
	assert.equal(sun.nextFlipMs, Date.parse("2026-09-07T01:00:00.000Z"));

	// Exact window boundaries on a weekend belong to the weekend, not to a peak day.
	const sunStart = getDeepSeekPeakInfo(Date.parse("2026-09-06T01:00:00.000Z"));
	assert.equal(sunStart.isPeak, false);
	assert.equal(sunStart.reason, "weekend");
	assert.equal(sunStart.nextFlipMs, Date.parse("2026-09-07T01:00:00.000Z"));

	const sunEnd = getDeepSeekPeakInfo(Date.parse("2026-09-06T10:00:00.000Z"));
	assert.equal(sunEnd.isPeak, false);
	assert.equal(sunEnd.reason, "weekend");
	assert.equal(sunEnd.nextFlipMs, Date.parse("2026-09-07T01:00:00.000Z"));
});

test("DeepSeek peak windows expose bounds and local ranges", () => {
	// Windows stay anchored to the UTC clock regardless of local timezone.
	assert.deepEqual(DEEPSEEK_PEAK_WINDOWS, [[60, 240], [360, 600]]);

	const t0100 = Date.parse("2026-09-07T01:00:00.000Z");
	const active = getDeepSeekPeakInfo(t0100);
	assert.equal(active.windowStartMs, t0100);
	assert.equal(active.windowEndMs, Date.parse("2026-09-07T04:00:00.000Z"));

	const offPeak = getDeepSeekPeakInfo(Date.parse("2026-09-07T10:00:00.000Z"));
	assert.equal(offPeak.windowStartMs, Date.parse("2026-09-08T01:00:00.000Z"));
	assert.equal(offPeak.windowEndMs, Date.parse("2026-09-08T04:00:00.000Z"));

	// Local range is a 3-hour span for window 1 and always parses as HH:MM–HH:MM.
	assert.match(formatLocalTimeRange(active.windowStartMs, active.windowEndMs, t0100), /^\d{2}:\d{2}( [+-]1)?–\d{2}:\d{2}( [+-]1)?$/);
	const label = formatDeepSeekPeakWindows(t0100);
	assert.match(label, /01:00–04:00 UTC/);
	assert.match(label, /06:00–10:00 UTC/);
	assert.match(label, /\(local\)/);
	assert.match(label, /Mon–Fri \(UTC\)/);

	// A weekend anchors to the coming weekday, so both show identical clock
	// times and neither invents a cross-midnight suffix.
	const weekendLabel = formatDeepSeekPeakWindows(Date.parse("2026-09-12T06:00:00.000Z"));
	assert.equal(weekendLabel, formatDeepSeekPeakWindows(Date.parse("2026-09-14T06:00:00.000Z")));
});

test("DeepSeek peak windows follow the coming weekday across a DST change", () => {
	const original = process.env.TZ;
	process.env.TZ = "America/New_York";
	try {
		// US DST starts Sun 2026-03-08, so Saturday's readout must already show
		// the EDT clock times of the Monday windows it describes.
		const saturday = formatDeepSeekPeakWindows(Date.parse("2026-03-07T12:00:00.000Z"));
		assert.match(saturday, /21:00–00:00 \+1, 02:00 \+1–06:00 \+1 \(local\)/);
		assert.equal(saturday, formatDeepSeekPeakWindows(Date.parse("2026-03-09T12:00:00.000Z")));
		// A weekday anchors to its own UTC day, using that day's offset.
		assert.match(
			formatDeepSeekPeakWindows(Date.parse("2026-03-06T12:00:00.000Z")),
			/20:00–23:00, 01:00 \+1–05:00 \+1 \(local\)/,
		);
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}

});

test("usesDeepSeekPeakPricing covers the DeepSeek API and DeepSeek models", () => {
	assert.equal(usesDeepSeekPeakPricing("deepseek"), true);
	assert.equal(usesDeepSeekPeakPricing("opencode-go", "deepseek-v3"), true);
	assert.equal(usesDeepSeekPeakPricing("opencode-go", "claude-sonnet-4"), false);
	assert.equal(usesDeepSeekPeakPricing("openai-codex", "gpt-5"), false);
	assert.equal(usesDeepSeekPeakPricing(undefined, undefined), false);
});

test("formatBalance renders symbols and falls back to the currency code", () => {
	assert.equal(formatBalance({ currency: "USD", total: 12.34 }), "$12.34");
	assert.equal(formatBalance({ currency: "CNY", total: 100 }), "¥100.00");
	assert.equal(formatBalance({ currency: "SGD", total: 5.5 }), "5.50 SGD");
});

test("normalizeUsageData keeps balance-only payloads for pay-as-you-go providers", () => {
	assert.deepEqual(
		normalizeUsageData({ windows: {}, balance: { currency: "usd", total: 7.5 } }),
		{ windows: {}, balance: { currency: "USD", total: 7.5 } },
	);
	assert.deepEqual(
		normalizeUsageData({ balance: { currency: "USD", total: 1 } }),
		{ windows: {}, balance: { currency: "USD", total: 1 } },
	);
	// Malformed balances are dropped, and empty payloads still normalize to undefined.
	assert.equal(normalizeUsageData({ windows: {}, balance: { currency: "USD" } }), undefined);
	assert.equal(normalizeUsageData({ windows: {}, balance: { total: 5 } }), undefined);
	assert.equal(normalizeUsageData({ windows: {} }), undefined);
});

test("deepseekCfg.render shows the local peak window plus the account balance", () => {
	const rendered = deepseekCfg.render(
		{ windows: {}, balance: { currency: "USD", total: 12.34 } },
		mockTheme,
	);
	assert.match(rendered, /^(Peak|Off-Peak) ~/);

	// Both peak and off-peak show only the countdown (no time window).
	const peakTag = deepSeekPeakTag(mockTheme, Date.parse("2026-09-07T02:00:00.000Z"));
	assert.equal(peakTag, "Peak ~2h");

	const offPeakTag = deepSeekPeakTag(mockTheme, Date.parse("2026-09-07T05:00:00.000Z"));
	assert.equal(offPeakTag, "Off-Peak ~1h");

	// Weekend off-peak names the reason so a multi-day wait is explicable.
	const weekendTag = deepSeekPeakTag(mockTheme, Date.parse("2026-09-05T06:00:00.000Z"));
	assert.equal(weekendTag, "Off-Peak ~1d (weekend)");
	assert.match(rendered, /\$12\.34$/);
	// The peak tag is theme-colored: warning while peak, dim while off-peak.
	const now = Date.now();
	const expectedColor = getDeepSeekPeakInfo(now).isPeak ? "warning" : "dim";
	const colors: string[] = [];
	deepSeekPeakTag({ fg: (color, text) => { colors.push(color); return text; } }, now);
	assert.deepEqual(colors, [expectedColor]);
});

test("formatUsageDetails reports the DeepSeek balance and both peak windows", () => {
	const text = formatUsageDetails(
		{ windows: {}, balance: { currency: "USD", total: 3.5 } },
		"deepseek",
		{ now: Date.parse("2026-09-07T02:00:00.000Z") },
	);
	assert.match(text, /Subscription usage — deepseek/);
	assert.match(text, /• balance: \$3\.50/);
	assert.match(text, /• deepseek pool: Peak hours ~2h left/);
	assert.match(text, /• peak windows: .*01:00–04:00 UTC, 06:00–10:00 UTC/);

	const offPeakText = formatUsageDetails(
		{ windows: {}, balance: { currency: "USD", total: 3.5 } },
		"deepseek",
		{ now: Date.parse("2026-09-07T05:00:00.000Z") },
	);
	assert.match(offPeakText, /• deepseek pool: Off-peak ~1h until peak$/m);

	// Weekend stretches add the reason, and past a day the absolute resume time.
	const weekendText = formatUsageDetails(
		{ windows: {}, balance: { currency: "USD", total: 3.5 } },
		"deepseek",
		{ now: Date.parse("2026-09-05T06:00:00.000Z") },
	);
	assert.match(weekendText, /• deepseek pool: Off-peak ~1d until peak \(weekend\) — resumes 2026-09-07 01:00 UTC$/m);
});

test("earliestReset falls back to standard interval if expired reset was already fetched", () => {
	const now = 1_000_000;
	const data: UsageData = {
		windows: { "5h": 20 },
		resets: { "5h": now - 10_000 },
	};
	const earliest = earliestReset(data, "gpt-5", "openai-codex", now);
	assert.equal(earliest, now - 10_000);
});

test("resolveRefreshTargets defaults to every provider and honours narrowing", () => {
	const all = usageProviderCfgs.map((c) => c.id);
	assert.deepEqual(resolveRefreshTargets("", usageProviderCfgs)?.map((c) => c.id), all);
	assert.deepEqual(resolveRefreshTargets("  ALL  ", usageProviderCfgs)?.map((c) => c.id), all);
	assert.deepEqual(
		resolveRefreshTargets("active", usageProviderCfgs, "openai-codex")?.map((c) => c.id),
		["openai-codex"],
	);
	assert.deepEqual(
		resolveRefreshTargets("OpenCode-Go", usageProviderCfgs)?.map((c) => c.id),
		["opencode-go"],
	);
	// Unambiguous aliases resolve to exactly one provider.
	assert.deepEqual(resolveRefreshTargets("codex", usageProviderCfgs)?.map((c) => c.id), [
		"openai-codex",
	]);
	assert.deepEqual(resolveRefreshTargets("zen", usageProviderCfgs)?.map((c) => c.id), [
		"opencode-go",
	]);
	assert.deepEqual(resolveRefreshTargets("google", usageProviderCfgs)?.map((c) => c.id), [
		"antigravity",
	]);
});

test("resolveRefreshTargets returns undefined for unresolvable targets", () => {
	assert.equal(resolveRefreshTargets("bogus", usageProviderCfgs), undefined);
	assert.equal(resolveRefreshTargets("active", usageProviderCfgs), undefined);
	assert.equal(resolveRefreshTargets("active", usageProviderCfgs, "ollama"), undefined);
});

test("resolveRefreshTargets never yields duplicates", () => {
	const ids = resolveRefreshTargets("all", usageProviderCfgs)!.map((c) => c.id);
	assert.equal(new Set(ids).size, ids.length);
});

test("formatRefreshNotice summarises single and fan-out outcomes", () => {
	assert.equal(formatRefreshNotice([]), "No usage providers to refresh");
	assert.equal(
		formatRefreshNotice([{ id: "openai-codex", outcome: "fetched" }]),
		"Usage refreshed for openai-codex",
	);
	assert.equal(
		formatRefreshNotice([{ id: "deepseek", outcome: "cached" }]),
		"Usage refresh finished from cache for deepseek",
	);
	assert.match(
		formatRefreshNotice([{ id: "deepseek", outcome: "skipped" }]),
		/skipped for deepseek \(no credentials\)/,
	);
	assert.match(
		formatRefreshNotice([{ id: "deepseek", outcome: "failed" }]),
		/failed for deepseek/,
	);
	assert.equal(
		formatRefreshNotice([
			{ id: "a", outcome: "fetched" },
			{ id: "b", outcome: "fetched" },
		]),
		"Usage refreshed for all 2 providers (a, b)",
	);
	const mixed = formatRefreshNotice([
		{ id: "a", outcome: "fetched" },
		{ id: "b", outcome: "cached" },
		{ id: "c", outcome: "skipped" },
		{ id: "d", outcome: "failed" },
	]);
	assert.match(mixed, /Usage refreshed for a/);
	assert.match(mixed, /from cache: b/);
	assert.match(mixed, /no credentials: c/);
	assert.match(mixed, /failed: d/);
	assert.equal(
		formatRefreshNotice([
			{ id: "a", outcome: "cached" },
			{ id: "b", outcome: "skipped" },
		]),
		"No usage data refreshed · from cache: a · no credentials: b",
	);
});
