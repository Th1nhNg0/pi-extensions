import assert from "node:assert/strict";
import fs from "node:fs";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import subscriptionUsage, {
	antigravityCfg,
	codexCfg,
	deepseekCfg,
	MissingCredentialError,
	opencodeCfg,
	usageProviderCfgs,
} from "../extensions/subscription-usage.ts";

async function flush() {
	// Drain the scheduler's async cache/read/write continuations without real timers.
	for (let i = 0; i < 60; i++) await Promise.resolve();
}

function harness(t: TestContext, mode = "bars") {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	t.mock.method(Math, "random", () => 0.5);
	t.mock.method(console, "error", () => {});
	t.mock.method(fs, "readFileSync", () => JSON.stringify({ mode }));
	t.mock.method(fs.promises, "readFile", async () => "{}");
	t.mock.method(fs.promises, "mkdir", async () => undefined);
	t.mock.method(fs.promises, "writeFile", async () => {});
	t.mock.method(fs.promises, "rename", async () => {});
	t.mock.method(fs.promises, "unlink", async () => {});
	let watchListener: (curr: fs.Stats, prev: fs.Stats) => void;
	const watch = t.mock.method(fs, "watchFile", (...args: unknown[]) => {
		watchListener = args.at(-1) as typeof watchListener;
		return {};
	});
	const unwatch = t.mock.method(fs, "unwatchFile", () => {});
	// Every provider is mocked: `/usage refresh` fans out by default, so an
	// unmocked provider would attempt a real network request.
	const fetch = t.mock.method(codexCfg, "fetchUsage", async () => ({ windows: { "5h": 12 } }));
	const providerFetches = {
		"opencode-go": t.mock.method(opencodeCfg, "fetchUsage", async () => ({ windows: { rolling: 5 } })),
		"openai-codex": fetch,
		antigravity: t.mock.method(antigravityCfg, "fetchUsage", async () => ({ windows: { "gemini-5h": 8 } })),
		deepseek: t.mock.method(deepseekCfg, "fetchUsage", async () => ({ windows: { "deepseek-5h": 3 } })),
	};
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-5" },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	subscriptionUsage({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, handler),
		registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
	} as unknown as ExtensionAPI);
	async function event(name: string) {
		await events.get(name)!({}, ctx);
		await flush();
	}
	t.after(async () => { await event("session_shutdown"); });
	return { watch, unwatch, fetch, providerFetches, statuses, ctx, event, commands,
		get watchListener() { return watchListener; },
	};
}

test("usage watcher starts only with a session and shutdown removes only its listener", async (t) => {
	const h = harness(t);
	assert.equal(h.watch.mock.callCount(), 0);
	await h.event("session_start");
	assert.equal(h.watch.mock.callCount(), 1);
	await h.event("session_shutdown");
	const args = h.unwatch.mock.calls[0].arguments;
	assert.equal(args[1], h.watchListener);
});

test("scheduled retries recover after failure while event pokes respect backoff", async (t) => {
	const h = harness(t);
	let attempts = 0;
	h.fetch.mock.mockImplementation(async () => {
		if (++attempts <= 2) throw new Error("temporary outage");
		return { windows: { "5h": 12 } };
	});
	await h.event("session_start");
	assert.equal(attempts, 1);
	await h.event("agent_settled");
	assert.equal(attempts, 1);
	t.mock.timers.tick(20_000);
	await flush();
	assert.equal(attempts, 2);
	t.mock.timers.tick(40_000);
	await flush();
	assert.equal(attempts, 3);
	assert.match(h.statuses.get("openai-codex")!, /12%/);
});

test("manual refresh while hidden does not fetch, render, or start polling", async (t) => {
	const h = harness(t, "off");
	await h.event("session_start");
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 0);
	assert.equal(h.statuses.size, 0);
	t.mock.timers.tick(600_000);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 0);
});

test("hiding usage discards an outstanding provider result", async (t) => {
	const h = harness(t);
	let finish!: (data: { windows: Record<string, number> }) => void;
	h.fetch.mock.mockImplementation(() => new Promise<{ windows: Record<string, number> }>((resolve) => { finish = resolve; }));
	await h.event("session_start");
	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	finish({ windows: { "5h": 12 } });
	await flush();
	assert.equal(h.statuses.get("openai-codex"), undefined);
	t.mock.timers.tick(600_000);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 1);
});

test("disk sync cannot restore polling after shutdown during a cache read", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	let finish!: (data: string) => void;
	t.mock.method(fs.promises, "readFile", () => new Promise<string>((resolve) => { finish = resolve; }));
	h.watchListener({ mtimeMs: 2 } as fs.Stats, { mtimeMs: 1 } as fs.Stats);
	t.mock.timers.tick(100);
	await flush();
	await h.event("session_shutdown");
	finish(JSON.stringify({ "openai-codex": {
		data: { windows: { "5h": 99 } }, fetchedAt: Date.now() + 1,
	} }));
	await flush();
	assert.equal(h.statuses.get("openai-codex"), undefined);
	t.mock.timers.tick(600_000);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 1);
});

test("/usage shows all providers", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	assert.ok(h.commands.has("usage"));
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	h.fetch.mock.mockImplementation(async () => ({
		windows: { "5h": 12, weekly: 34 },
		resets: { "5h": Date.now() + 3600_000, weekly: Date.now() + 86400_000 },
		plan: "plus",
	}));
	await h.commands.get("usage")!.handler("", h.ctx);
	await flush();
	const last = notices.at(-1)!;
	assert.match(last, /Subscription usage — openai-codex/);
	assert.match(last, /• 5h: 12%/);
	assert.match(last, /• weekly: 34%/);
	// Default view covers every provider; unconfigured ones report no data.
	assert.match(last, /opencode-go/);
	assert.match(last, /antigravity/);
});

test("/usage works while hidden without fetching", async (t) => {
	const h = harness(t, "off");
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("", h.ctx);
	await flush();
	assert.equal(h.fetch.mock.callCount(), 0);
	assert.match(notices.at(-1)!, /opencode-go/);
	assert.match(notices.at(-1)!, /Footer hidden/);
});

test("/usage toggle cycles footer style", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("toggle", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /Subscription usage style: percent/);
	await h.commands.get("usage")!.handler("toggle bars", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /Subscription usage style: bars/);
});

test("/usage refresh force-fetches every provider by default", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	assert.equal(h.fetch.mock.callCount(), 1);
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	await flush();
	// Session start fetched the active provider only; the default refresh
	// fans out to every configured provider.
	assert.equal(h.fetch.mock.callCount(), 2);
	for (const [id, mocked] of Object.entries(h.providerFetches)) {
		if (id === "openai-codex") continue;
		assert.equal(mocked.mock.callCount(), 1, id);
	}
	assert.match(notices.at(-1)!, /Usage refreshed for all 4 providers/);
});

test("/usage refresh <provider> refreshes only that provider", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh deepseek", h.ctx);
	await flush();
	assert.equal(h.providerFetches.deepseek.mock.callCount(), 1);
	assert.equal(h.providerFetches["opencode-go"].mock.callCount(), 0);
	assert.equal(h.fetch.mock.callCount(), 1); // session start only
	assert.equal(notices.at(-1), "Usage refreshed for deepseek");
});

test("/usage refresh active and provider aliases target one provider", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh active", h.ctx);
	await flush();
	assert.equal(notices.at(-1), "Usage refreshed for openai-codex");
	// `codex` is an unambiguous alias for the openai-codex provider.
	await h.commands.get("usage")!.handler("refresh codex", h.ctx);
	await flush();
	assert.equal(notices.at(-1), "Usage refreshed for openai-codex");
	assert.equal(h.providerFetches.deepseek.mock.callCount(), 0);
	assert.equal(h.providerFetches["opencode-go"].mock.callCount(), 0);
});

test("/usage refresh with an unknown target warns without any request", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: { msg: string; level?: string }[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string, level?: string) => void }).notify = (msg, level) =>
		notices.push({ msg, level });
	const before = [h.fetch.mock.callCount(), h.providerFetches.deepseek.mock.callCount()];
	await h.commands.get("usage")!.handler("refresh bogus", h.ctx);
	await flush();
	assert.equal(notices.at(-1)!.level, "warning");
	assert.match(notices.at(-1)!.msg, /Unknown usage provider/);
	assert.deepEqual([h.fetch.mock.callCount(), h.providerFetches.deepseek.mock.callCount()], before);
});

test("fan-out refresh writes a footer status for the active provider only", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	await flush();
	// Providers we are not using must not leak status widgets into the footer.
	for (const cfg of usageProviderCfgs) {
		if (cfg.id === "openai-codex") continue;
		assert.equal(h.statuses.get(cfg.id), undefined, cfg.id);
	}
	assert.match(h.statuses.get("openai-codex")!, /12%/);
});

test("a provider without credentials is reported as skipped, not failed", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	h.providerFetches.deepseek.mock.mockImplementation(async () => {
		throw new MissingCredentialError("no API key (DEEPSEEK_API_KEY or auth.json)");
	});
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /no credentials: deepseek/);
	assert.doesNotMatch(notices.at(-1)!, /failed:/);
});

test("a provider whose fetch rejects is reported as failed", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	h.providerFetches.deepseek.mock.mockImplementation(async () => {
		throw new Error("HTTP 503");
	});
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("refresh", h.ctx);
	await flush();
	assert.match(notices.at(-1)!, /failed: deepseek/);
});

test("/usage help and unknown subcommands notify", async (t) => {
	const h = harness(t);
	await h.event("session_start");
	const notices: string[] = [];
	(h.ctx.ui as unknown as { notify: (msg: string) => void }).notify = (msg: string) => notices.push(msg);
	await h.commands.get("usage")!.handler("help", h.ctx);
	await h.commands.get("usage")!.handler("bogus", h.ctx);
	await flush();
	assert.match(notices[0], /\/usage toggle/);
	assert.match(notices[1], /Unknown subcommand/);
});

test("event pokes arriving during retry backoff do not postpone the retry deadline", async (t) => {
	const h = harness(t);
	let attempts = 0;
	h.fetch.mock.mockImplementation(async () => {
		if (++attempts === 1) throw new Error("outage");
		return { windows: { "5h": 50 } };
	});

	await h.event("session_start");
	assert.equal(attempts, 1);

	// Poke halfway through the 20s backoff (at 10s)
	t.mock.timers.tick(10_000);
	await h.event("agent_settled");
	assert.equal(attempts, 1);

	// Advance the remaining 10s to reach the original 20s deadline
	t.mock.timers.tick(10_000);
	await flush();
	// The retry must fire at the original 20s deadline, NOT postponed to 30s!
	assert.equal(attempts, 2);
	assert.match(h.statuses.get("openai-codex")!, /50%/);
});

test("toggling usage off aborts active fetch via signal", async (t) => {
	const h = harness(t);
	let receivedSignal: AbortSignal | undefined;
	h.fetch.mock.mockImplementation(async (signal?: AbortSignal) => {
		receivedSignal = signal;
		return new Promise<{ windows: Record<string, number> }>((_, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("aborted")));
		});
	});

	await h.event("session_start");
	assert.ok(receivedSignal);
	assert.equal(receivedSignal.aborted, false);

	await h.commands.get("usage")!.handler("toggle off", h.ctx);
	await flush();
	assert.equal(receivedSignal.aborted, true);
});

test("concurrent model selections coalesce in-flight fetch without duplicate HTTP requests", async (t) => {
	const h = harness(t);
	let finish!: (d: { windows: Record<string, number> }) => void;
	h.fetch.mock.mockImplementation(async () => new Promise<{ windows: Record<string, number> }>((resolve) => { finish = resolve; }));

	await h.event("session_start");
	assert.equal(h.fetch.mock.callCount(), 1);

	// Rapid model selections while request is in flight
	await h.event("model_select");
	await h.event("model_select");
	assert.equal(h.fetch.mock.callCount(), 1);

	finish({ windows: { "5h": 25 } });
	await flush();
	assert.match(h.statuses.get("openai-codex")!, /25%/);
});
