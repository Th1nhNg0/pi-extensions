import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	claudeCfg,
	formatUsageDetails,
	MissingCredentialError,
	parseClaudeUsage,
	resolveClaudeCredential,
	resolveRefreshTargets,
	usageProviderCfgs,
} from "../extensions/subscription-usage.ts";

const theme = { fg: (_color: string, text: string) => text };
const NOW = Date.parse("2026-09-28T08:00:00Z");

const RESPONSE = {
	five_hour: { utilization: 12, resets_at: "2026-09-28T10:00:00.000Z" },
	seven_day: { utilization: 45.5, resets_at: "2026-10-02T00:00:00+00:00" },
	seven_day_opus: { utilization: 80, resets_at: "2026-10-02T00:00:00Z" },
	seven_day_sonnet: null,
	seven_day_oauth_apps: null,
	extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

test("parseClaudeUsage maps buckets to windows with reset times", () => {
	const data = parseClaudeUsage(RESPONSE, "max");
	assert.deepEqual(data.windows, { "5h": 12, weekly: 45.5, "weekly-opus": 80 });
	assert.equal(data.resets?.["5h"], Date.parse("2026-09-28T10:00:00Z"));
	assert.equal(data.resets?.weekly, Date.parse("2026-10-02T00:00:00Z"));
	assert.equal(data.plan, "max");
});

test("parseClaudeUsage clamps, keeps enabled extra usage, and rejects empty payloads", () => {
	const data = parseClaudeUsage({
		five_hour: { utilization: 130, resets_at: "not a date" },
		extra_usage: { is_enabled: true, utilization: 25 },
	});
	assert.deepEqual(data.windows, { "5h": 100, extra: 25 });
	assert.equal(data.resets, undefined);
	assert.throws(() => parseClaudeUsage({ five_hour: null, seven_day: {} }), /no usage data/);
});

test("the Claude footer shows 5h, weekly, and the active model's own weekly cap", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: NOW });
	const data = parseClaudeUsage(RESPONSE);
	const opus = claudeCfg.render(data, theme, "claude-opus-5", "percent");
	assert.match(opus, /^5h 12% ~2h · W 45\.5% ~3d · Opus 80% ~3d$/);
	const sonnet = claudeCfg.render(data, theme, "claude-sonnet-5", "percent");
	assert.doesNotMatch(sonnet, /Opus|Sonnet/, "no Sonnet bucket in this payload");
	assert.equal(claudeCfg.render({ windows: {} }, theme, "claude-opus-5"), "");
	const details = formatUsageDetails(data, "anthropic", { modelId: "claude-opus-5", now: NOW });
	assert.match(details, /anthropic • claude-opus-5/);
	assert.ok(details.indexOf("weekly:") < details.indexOf("weekly-opus:"));
});

test("anthropic is a usage provider, reachable as claude / claude-code", () => {
	assert.ok(usageProviderCfgs.includes(claudeCfg));
	assert.equal(claudeCfg.id, "anthropic");
	assert.equal(claudeCfg.quietWithoutCredential, true);
	for (const alias of ["claude", "claude-code", "anthropic"]) {
		assert.deepEqual(
			resolveRefreshTargets(alias, usageProviderCfgs)?.map((c) => c.id),
			["anthropic"],
		);
	}
});

async function credentialDirs(t: TestContext) {
	const root = await mkdtemp(join(os.tmpdir(), "pi-claude-usage-"));
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(async () => {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		await rm(root, { recursive: true, force: true });
	});
	return {
		claudeCode: join(root, "claude-credentials.json"),
		async piAuth(value: unknown) {
			await writeFile(join(root, "auth.json"), JSON.stringify(value));
		},
		async claudeCodeAuth(value: unknown) {
			await writeFile(join(root, "claude-credentials.json"), JSON.stringify(value));
		},
	};
}

test("resolveClaudeCredential prefers env OAuth tokens and ignores plain API keys", async (t) => {
	const dirs = await credentialDirs(t);
	assert.deepEqual(
		resolveClaudeCredential(
			NOW,
			{ CLAUDE_CODE_OAUTH_TOKEN: " sk-ant-oat01-env " },
			dirs.claudeCode,
		),
		{ access: "sk-ant-oat01-env" },
	);
	assert.deepEqual(
		resolveClaudeCredential(NOW, { ANTHROPIC_API_KEY: "sk-ant-oat01-key" }, dirs.claudeCode),
		{ access: "sk-ant-oat01-key" },
	);
	assert.throws(
		() => resolveClaudeCredential(NOW, { ANTHROPIC_API_KEY: "sk-ant-api03-x" }, dirs.claudeCode),
		(error: unknown) =>
			error instanceof MissingCredentialError && /no Claude subscription/.test(error.message),
	);
});

test("resolveClaudeCredential reads Pi's login, then Claude Code's, and never uses expired tokens", async (t) => {
	const dirs = await credentialDirs(t);
	await dirs.piAuth({
		anthropic: { type: "oauth", access: "pi-token", refresh: "r", expires: NOW + 60_000 },
	});
	await dirs.claudeCodeAuth({
		claudeAiOauth: { accessToken: "cc-token", expiresAt: NOW + 60_000, subscriptionType: "max" },
	});
	assert.deepEqual(resolveClaudeCredential(NOW, {}, dirs.claudeCode), { access: "pi-token" });

	// Pi's token expired: fall through to Claude Code's, which carries the plan.
	await dirs.piAuth({
		anthropic: { type: "oauth", access: "pi-token", refresh: "r", expires: NOW - 1 },
	});
	assert.deepEqual(resolveClaudeCredential(NOW, {}, dirs.claudeCode), {
		access: "cc-token",
		plan: "max",
	});

	// Both expired: unavailable (skipped), not a refresh that would rotate their tokens.
	await dirs.claudeCodeAuth({ claudeAiOauth: { accessToken: "cc-token", expiresAt: NOW - 1 } });
	assert.throws(
		() => resolveClaudeCredential(NOW, {}, dirs.claudeCode),
		(error: unknown) => error instanceof MissingCredentialError && /expired/.test(error.message),
	);

	// An API-key login for anthropic has no subscription usage.
	await dirs.piAuth({ anthropic: { type: "api_key", key: "sk-ant-api03-x" } });
	await rm(dirs.claudeCode);
	assert.throws(() => resolveClaudeCredential(NOW, {}, dirs.claudeCode), MissingCredentialError);
});

test("claudeCfg.fetchUsage calls the OAuth usage endpoint with the beta header", async (t) => {
	const dirs = await credentialDirs(t);
	void dirs;
	const saved = process.env.ANTHROPIC_OAUTH_TOKEN;
	process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat01-test";
	t.after(() => {
		if (saved === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
		else process.env.ANTHROPIC_OAUTH_TOKEN = saved;
	});
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		calls.push({ url, headers: init.headers as Record<string, string> });
		return new Response(JSON.stringify(RESPONSE), { status: 200 });
	});
	const data = await claudeCfg.fetchUsage();
	assert.equal(calls[0].url, "https://api.anthropic.com/api/oauth/usage");
	assert.equal(calls[0].headers.Authorization, "Bearer sk-ant-oat01-test");
	assert.equal(calls[0].headers["anthropic-beta"], "oauth-2025-04-20");
	assert.equal(data.windows["5h"], 12);

	t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
	await assert.rejects(claudeCfg.fetchUsage(), /HTTP 401/);
});
