import { randomUUID } from "node:crypto";

export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

export interface SubagentTrackerEventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | undefined;
	emit(event: string, data: unknown): void;
}

export interface SubagentTrackerOptions {
	events?: SubagentTrackerEventBus;
	sessionId: string;
	onCountChange?: (count: number) => unknown;
}

export class SubagentTracker {
	private readonly events?: SubagentTrackerEventBus;
	private readonly sessionId: string;
	private readonly onCountChange?: (count: number) => unknown;
	private activeAsyncRuns = new Set<string>();
	private activeForegroundCalls = new Set<string>();
	private rpcActiveCount: number | undefined;
	private installed = false;
	private unsubscribers: Array<() => void> = [];
	private lastNotifiedCount = 0;
	private activeRpcCleanups = new Map<string, () => void>();
	private latestRpcRequestId: string | undefined;

	constructor(options: SubagentTrackerOptions) {
		this.events = options.events;
		this.sessionId = options.sessionId;
		this.onCountChange = options.onCountChange;
		this.subscribeEvents();
	}

	private subscribeEvents(): void {
		if (!this.events) return;

		const unsubStart = this.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const ev = data as { id?: string; runId?: string; sessionId?: string };
			const id = ev.id ?? ev.runId;
			if (!id || typeof id !== "string") return;
			if (ev.sessionId && this.sessionId && ev.sessionId !== this.sessionId) return;
			this.installed = true;
			this.activeAsyncRuns.add(id);
			this.rpcActiveCount = undefined;
			this.emitCount();
		});
		if (typeof unsubStart === "function") this.unsubscribers.push(unsubStart);

		const unsubEnd = this.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const ev = data as { id?: string; runId?: string };
			const id = ev.runId ?? ev.id;
			if (!id || typeof id !== "string") return;
			if (this.activeAsyncRuns.delete(id)) {
				this.rpcActiveCount = undefined;
				this.emitCount();
			}
		});
		if (typeof unsubEnd === "function") this.unsubscribers.push(unsubEnd);

		const unsubReady = this.events.on(SUBAGENT_RPC_READY_EVENT, () => {
			this.installed = true;
			this.queryRpcStatus();
		});
		if (typeof unsubReady === "function") this.unsubscribers.push(unsubReady);
	}

	onToolExecutionStart(toolCallId: string, toolName?: string): void {
		if (!toolName) return;
		const normalized = toolName.trim().toLowerCase();
		if (
			normalized === "subagent" ||
			normalized.includes("subagent") ||
			normalized.includes("sub-agent")
		) {
			this.installed = true;
			this.activeForegroundCalls.add(toolCallId);
			this.emitCount();
		}
	}

	onToolExecutionEnd(toolCallId: string): void {
		if (this.activeForegroundCalls.delete(toolCallId)) {
			this.emitCount();
		}
	}

	markInstalled(): void {
		this.installed = true;
	}

	isInstalled(): boolean {
		return this.installed;
	}

	queryRpcStatus(): void {
		if (!this.events) return;
		if (this.latestRpcRequestId) {
			const prevCleanup = this.activeRpcCleanups.get(this.latestRpcRequestId);
			if (prevCleanup) prevCleanup();
		}
		const requestId = randomUUID();
		this.latestRpcRequestId = requestId;
		const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;

		let unsub: (() => void) | undefined;
		const cleanup = (): void => {
			clearTimeout(timer);
			this.activeRpcCleanups.delete(requestId);
			unsub?.();
		};

		const timer = setTimeout(cleanup, 4000);
		timer.unref?.();

		const unlisten = this.events.on(replyEvent, (reply) => {
			cleanup();
			if (this.latestRpcRequestId !== requestId) return;
			if (!reply || typeof reply !== "object") return;
			const res = reply as {
				ok?: boolean;
				result?: { fleet?: { totalActive?: number } };
			};
			const totalActive = res.result?.fleet?.totalActive;
			if (
				res.ok &&
				typeof totalActive === "number" &&
				Number.isFinite(totalActive) &&
				totalActive >= 0
			) {
				this.installed = true;
				this.rpcActiveCount = Math.floor(totalActive);
				this.emitCount();
			}
		});

		if (typeof unlisten === "function") {
			unsub = unlisten;
		}
		this.activeRpcCleanups.set(requestId, cleanup);

		try {
			this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
				version: SUBAGENT_RPC_PROTOCOL_VERSION,
				requestId,
				method: "status",
				params: { action: "status" },
			});
		} catch {
			cleanup();
		}
	}

	getTotalActiveCount(): number {
		const tracked = this.activeAsyncRuns.size + this.activeForegroundCalls.size;
		if (this.rpcActiveCount !== undefined) {
			return Math.max(tracked, this.rpcActiveCount);
		}
		return tracked;
	}

	private emitCount(): void {
		const count = this.getTotalActiveCount();
		if (count !== this.lastNotifiedCount) {
			this.lastNotifiedCount = count;
			Promise.resolve(this.onCountChange?.(count)).catch(() => undefined);
		}
	}

	dispose(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
		for (const cleanup of this.activeRpcCleanups.values()) cleanup();
		this.activeRpcCleanups.clear();
		this.latestRpcRequestId = undefined;
		this.activeAsyncRuns.clear();
		this.activeForegroundCalls.clear();
		this.rpcActiveCount = undefined;
		this.lastNotifiedCount = 0;
	}
}
