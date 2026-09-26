/** Shared Discord publisher state machine and its RPC scheduling policy. */
import { randomUUID } from "node:crypto";
import {
	buildAggregateActivity,
	isActivityEqual,
	orderedSessions,
	parsePrivacyMode,
	type PresenceActivity,
	type PresencePrivacyMode,
} from "./activity.ts";
import { formatAction, type PresenceAction, type PresencePhase } from "./actions.ts";
import { formatModelLabel, truncateText } from "./model-labels.ts";
import {
	asRecord,
	cloneRecord,
	cloneUsage,
	emptyUsageTotals,
	finiteNonNegative,
	isSubagentRecord,
} from "./session-state.ts";
import type {
	ContextSnapshot,
	PresenceState,
	PresenceStateStore,
	SessionRecord,
	UsageTotals,
} from "./session-state.ts";
import { FilePresenceStateStore } from "./state-store.ts";
import { createDiscordPresenceTransport } from "./transport.ts";
import type { DiscordPresenceTransport } from "./transport.ts";
import { formatCost, formatTokenCount, mergeUsageTotals } from "./session-usage.ts";
import type { UsageDelta } from "./session-usage.ts";

export const CLIENT_ID_ENV = "PI_DISCORD_CLIENT_ID";
export const PRIVACY_ENV = "PI_DISCORD_PRIVACY";
export const MIN_INTERVAL_ENV = "PI_DISCORD_MIN_INTERVAL_MS";

/**
 * Discord's Rich Presence server accepts roughly one SET_ACTIVITY update
 * per 15 seconds. Publishing faster makes Discord silently empty the presence
 * and can close the RPC socket with close code 4002 (RATELIMITED).
 * See https://github.com/discord/discord-api-docs/issues/668.
 */
export const DEFAULT_MIN_PUBLISH_INTERVAL_MS = 15_000;
/** Back off at least one Rich Presence window after a rate limit. */
export const RATE_LIMIT_BACKOFF_MS = 15_000;
/**
 * Discord keeps the last activity until it changes or Discord clears it
 * (for example when another socket with the same client ID disconnects).
 * Re-assert unchanged activity periodically so a cleared presence recovers.
 */
export const PRESENCE_REASSERT_INTERVAL_MS = 60_000;

const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * Discord's RPC server allows 2 IPC connections per minute per client, so
 * the first reconnect delay must not burn that budget (initial connect plus
 * the first retry stays at two connections within the first minute).
 */
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 5 * 60_000;
const RPC_WRITE_TIMEOUT_MS = 10_000;

export type PresenceStatus =
	| "not-started"
	| "starting"
	| "connecting"
	| "connected"
	| "standby"
	| "reconnecting"
	| "disabled"
	| "stopped";

export interface PresenceManagerOptions {
	clientId: string;
	projectName: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	startedAt?: number;
	initialUsage?: UsageTotals;
	initialContext?: ContextSnapshot;
	createTransport?: (clientId: string) => DiscordPresenceTransport | Promise<DiscordPresenceTransport>;
	stateStore?: PresenceStateStore;
	logger?: (message: string) => void;
	now?: () => number;
	heartbeatMs?: number;
	retryBaseMs?: number;
	retryCapMs?: number;
	privacyMode?: PresencePrivacyMode;
	/** Reload shared privacy policy before publishing (including standby changes). */
	readPrivacyMode?: () => Promise<PresencePrivacyMode>;
	showCost?: boolean;
	enableButtons?: boolean;
	enableAssets?: boolean;
	largeImageKey?: string;
	smallImageKey?: string;
	initialActiveSubagents?: number;
	isSubagent?: boolean;
	minPublishIntervalMs?: number;
}

export function defaultLogger(message: string): void {
	process.stderr.write(`${message}\n`);
}

export function isRateLimitError(error: unknown): boolean {
	if (!error) return false;
	const record = asRecord(error);
	const code = record?.code;
	if (code === 4002 || code === "4002") return true;
	// 5011 is the RPC ERROR code for RATE_LIMITED; 4002 is the close code.
	if (code === 5011 || code === "5011") return true;
	const message =
		typeof record?.message === "string"
			? record.message.toLowerCase()
			: error instanceof Error
				? error.message.toLowerCase()
				: "";
	return (
		message.includes("rate limit") ||
		message.includes("rate_limit") ||
		message.includes("ratelimited") ||
		message.includes("4002") ||
		message.includes("5011")
	);
}

export function isRegistryLockError(error: unknown): boolean {
	if (!error) return false;
	const message = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return (
		message.includes("lock") ||
		message.includes("ownership lost") ||
		message.includes("state file") ||
		message.includes("registry")
	);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("Discord RPC request timed out")),
			timeoutMs,
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class DiscordPresenceManager {
	private readonly sessionId = randomUUID();
	private readonly clientId: string;
	private readonly stateStore: PresenceStateStore;
	private readonly createTransport: (
		clientId: string,
	) => DiscordPresenceTransport | Promise<DiscordPresenceTransport>;
	private readonly logger: (message: string) => void;
	private readonly now: () => number;
	private readonly heartbeatMs: number;
	private readonly retryBaseMs: number;
	private readonly retryCapMs: number;
	private privacyMode: PresencePrivacyMode;
	private readonly readPrivacyMode?: () => Promise<PresencePrivacyMode>;
	private showCost: boolean;
	private enableButtons?: boolean;
	private enableAssets?: boolean;
	private largeImageKey?: string;
	private smallImageKey?: string;
	private readonly record: SessionRecord;

	private status: PresenceStatus = "not-started";
	private started = false;
	private disposed = false;
	private publisher = false;
	private publisherGeneration = 0;
	private transport: DiscordPresenceTransport | undefined;
	private removeDisconnectedListener: (() => void) | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryAttempt = 0;
	private connectionPromise: Promise<boolean> | undefined;
	private registryQueue: Promise<void> = Promise.resolve();
	private presenceQueue: Promise<void> = Promise.resolve();
	private presenceDrain: Promise<void> | undefined;
	private pendingPresenceState: PresenceState | undefined;
	private outageWarningShown = false;
	private transportErrorWarningShown = false;
	private registryWarningShown = false;
	private readonly minPublishIntervalMs: number;
	private lastPublishTime = Number.NEGATIVE_INFINITY;
	private pendingPresenceForce = false;
	private pendingRegistryUpdate = false;
	private registryDrain: Promise<void> | undefined;
	private stopPromise: Promise<void> | undefined;
	private lastPublishedActivity: PresenceActivity | undefined;
	private rateLimitBackoffUntil = 0;
	private consecutiveRateLimits = 0;
	private publishThrottleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: PresenceManagerOptions) {
		this.clientId = options.clientId;
		this.stateStore = options.stateStore ?? new FilePresenceStateStore();
		this.createTransport =
			options.createTransport ?? createDiscordPresenceTransport;
		this.logger = options.logger ?? defaultLogger;
		this.now = options.now ?? Date.now;
		this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
		this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
		this.retryCapMs = options.retryCapMs ?? RETRY_CAP_MS;
		this.privacyMode =
			options.privacyMode ?? parsePrivacyMode(process.env[PRIVACY_ENV]);
		this.readPrivacyMode = options.readPrivacyMode;
		this.showCost = options.showCost ?? true;
		this.enableButtons = options.enableButtons;
		this.enableAssets = options.enableAssets;
		this.largeImageKey = options.largeImageKey;
		this.smallImageKey = options.smallImageKey;
		const configuredMinInterval = process.env[MIN_INTERVAL_ENV]
			? Number.parseInt(process.env[MIN_INTERVAL_ENV], 10)
			: undefined;
		this.minPublishIntervalMs =
			options.minPublishIntervalMs ??
			(Number.isFinite(configuredMinInterval) && (configuredMinInterval as number) >= 0
				? (configuredMinInterval as number)
				: options.createTransport
					? 0
					: DEFAULT_MIN_PUBLISH_INTERVAL_MS);
		const startedAt = options.startedAt ?? this.now();
		this.record = {
			sessionId: this.sessionId,
			projectName: options.projectName,
			provider: options.provider,
			modelId: options.modelId,
			thinkingLevel: options.thinkingLevel,
			phase: "idle",
			action: "idle",
			startedAt,
			lastSeenAt: startedAt,
			usage: cloneUsage(options.initialUsage ?? emptyUsageTotals()),
			context: options.initialContext ? { ...options.initialContext } : undefined,
			activeSubagents:
				options.initialActiveSubagents !== undefined &&
				options.initialActiveSubagents > 0
					? Math.floor(options.initialActiveSubagents)
					: undefined,
			isSubagent: options.isSubagent,
		};
	}

	getSessionId(): string {
		return this.sessionId;
	}

	isPublisher(): boolean {
		return this.publisher;
	}

	getStatus(): PresenceStatus {
		return this.status;
	}

	getPrivacyMode(): PresencePrivacyMode {
		return this.privacyMode;
	}

	setPrivacyMode(mode: PresencePrivacyMode): Promise<void> {
		this.privacyMode = mode;
		return this.refresh();
	}

	setShowCost(showCost: boolean): Promise<void> {
		this.showCost = showCost;
		return this.refresh();
	}

	setEnableButtons(enable: boolean | undefined): Promise<void> {
		this.enableButtons = enable;
		return this.refresh();
	}

	setEnableAssets(enable: boolean | undefined): Promise<void> {
		this.enableAssets = enable;
		return this.refresh();
	}

	getStatusText(): string {
		switch (this.status) {
			case "connected":
				return "connected (publisher)";
			case "connecting":
				return "connecting (publisher)";
			case "standby":
				return "standby (another session is publishing)";
			case "reconnecting":
				return "retrying";
			case "disabled":
				return "disabled";
			case "stopped":
				return "stopped";
			default:
				return "not started";
		}
	}

	async start(): Promise<void> {
		if (this.started || (this.disposed && this.status !== "stopped")) return;
		// A completed stop is reversible for /discord toggle on. Never restart
		// while stop() is still draining queues and releasing ownership.
		this.disposed = false;
		this.retryAttempt = 0;
		this.started = true;
		this.status = "starting";
		await this.enqueueRegistryUpdate();
		if (this.disposed) return;
		this.heartbeatTimer = setInterval(() => {
			void this.heartbeat();
		}, this.heartbeatMs);
		this.heartbeatTimer.unref?.();
		await this.refresh();
	}

	setModel(
		provider?: string,
		modelId?: string,
		thinkingLevel?: string,
	): Promise<void> {
		if (
			this.record.provider === provider &&
			this.record.modelId === modelId &&
			this.record.thinkingLevel === thinkingLevel
		) {
			return this.registryDrain ?? Promise.resolve();
		}
		this.record.provider = provider;
		this.record.modelId = modelId;
		this.record.thinkingLevel = thinkingLevel;
		return this.enqueueRegistryUpdate();
	}

	setThinkingLevel(thinkingLevel?: string): Promise<void> {
		if (this.record.thinkingLevel === thinkingLevel) {
			return this.registryDrain ?? Promise.resolve();
		}
		this.record.thinkingLevel = thinkingLevel;
		return this.enqueueRegistryUpdate();
	}

	setPhase(phase: PresencePhase, action?: PresenceAction): Promise<void> {
		const nextAction = action ?? (phase === "tools" ? "tools" : phase);
		if (this.record.phase === phase && this.record.action === nextAction) {
			return this.registryDrain ?? Promise.resolve();
		}
		this.record.phase = phase;
		this.record.action = nextAction;
		return this.enqueueRegistryUpdate();
	}

	setAction(action?: PresenceAction): Promise<void> {
		if (this.record.action === action) return this.registryDrain ?? Promise.resolve();
		this.record.action = action;
		return this.enqueueRegistryUpdate();
	}

	recordUsage(delta: UsageDelta): Promise<void> {
		this.record.usage = mergeUsageTotals(this.record.usage, delta);
		return this.enqueueRegistryUpdate();
	}

	setContextUsage(context: ContextSnapshot | undefined): Promise<void> {
		const current = this.record.context;
		if (current === context || (current && context &&
			current.tokens === context.tokens && current.contextWindow === context.contextWindow &&
			current.percent === context.percent)) return this.registryDrain ?? Promise.resolve();
		this.record.context = context ? { ...context } : undefined;
		return this.enqueueRegistryUpdate();
	}

	setActiveSubagents(count: number): Promise<void> {
		const safeCount = Math.floor(finiteNonNegative(count) ?? 0);
		const currentCount = this.record.activeSubagents ?? 0;
		if (currentCount === safeCount) return Promise.resolve();
		this.record.activeSubagents = safeCount > 0 ? safeCount : undefined;
		return this.enqueueRegistryUpdate();
	}

	getActiveSubagents(): number {
		return this.record.activeSubagents ?? 0;
	}

	/** Force a state read; useful for diagnostics and deterministic tests. */
	async refresh(): Promise<void> {
		if (!this.started || this.disposed) return;
		try {
			await this.applyState(await this.stateStore.read(), true, true);
		} catch {
			this.warnRegistryFailure();
		}
	}

	async getDiagnosticText(): Promise<string> {
		let state: PresenceState;
		try {
			state = await this.stateStore.read();
		} catch {
			return `Discord presence: ${this.getStatusText()}\nSession registry unavailable.`;
		}
		const records = orderedSessions(state);
		const publisherLabel = state.publisherId
			? truncateText(
					state.sessions[state.publisherId]?.projectName ?? "unknown",
					96,
				)
			: "none";
		const lines = [
			`Discord presence: ${this.getStatusText()} · Privacy: ${this.privacyMode}`,
			`Publisher: ${publisherLabel}`,
			`Sessions: ${records.length}`,
		];
		for (const record of records)
			lines.push(formatDiagnosticSession(record, this.now()));
		return lines.join("\n");
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const stopping = this.stopInternal();
		this.stopPromise = stopping;
		void stopping.then(
			() => { if (this.stopPromise === stopping) this.stopPromise = undefined; },
			() => { if (this.stopPromise === stopping) this.stopPromise = undefined; },
		);
		return stopping;
	}

	private async stopInternal(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.started = false;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.clearRetryTimer();
		this.clearPublishTimer();
		this.pendingPresenceForce = false;
		this.pendingRegistryUpdate = false;
		this.pendingPresenceState = undefined;
		this.lastPublishedActivity = undefined;
		this.consecutiveRateLimits = 0;
		this.rateLimitBackoffUntil = 0;
		await this.registryQueue.catch(() => undefined);
		await this.presenceQueue.catch(() => undefined);

		const wasPublisher = this.publisher;
		if (wasPublisher && this.transport) {
			await this.clearActivityOnShutdown();
		}
		this.publisher = false;
		try {
			await this.stateStore.remove(this.sessionId);
		} catch {
			this.warnRegistryFailure();
		}

		await this.closeTransport();
		this.status = "stopped";
	}

	/**
	 * Discord throttles SET_ACTIVITY clears too. Retry once after backoff, but
	 * recheck publisher ownership in case another Pi session takes over.
	 */
	private async clearActivityOnShutdown(): Promise<void> {
		const transport = this.transport;
		if (!transport) return;

		for (let attempt = 0; attempt < 2; attempt += 1) {
			let retryAfterRateLimit = false;
			try {
				await this.stateStore.withPublisherLock(
					this.sessionId,
					this.publisherGeneration,
					async (assertOwnership) => {
						const current = await this.stateStore.read();
						const mainSessions = Object.values(current.sessions).filter(
							(record) => !isSubagentRecord(record),
						);
						if (
							current.publisherId !== this.sessionId ||
							mainSessions.length > 1 ||
							this.transport !== transport
						) {
							return;
						}

						await assertOwnership();
						try {
							await awaitWithTimeout(
								transport.clearActivity(),
								RPC_WRITE_TIMEOUT_MS,
							);
						} catch (error) {
							if (
								attempt === 0 &&
								isRateLimitError(error) &&
								transport.isConnected()
							) {
								this.logger(
									"[discord-presence] Presence cleanup was rate-limited; retrying after backoff.",
								);
								retryAfterRateLimit = true;
								return;
							}
							if (isRateLimitError(error)) {
								this.logger(
									"[discord-presence] Discord rate-limited presence cleanup during shutdown.",
								);
							}
						}
					},
				);
			} catch {
				this.warnRegistryFailure();
				return;
			}

			if (!retryAfterRateLimit) return;
			await wait(Math.max(RATE_LIMIT_BACKOFF_MS, this.minPublishIntervalMs));
		}
	}

	private async heartbeat(): Promise<void> {
		if (!this.started || this.disposed) return;
		await this.enqueueRegistryUpdate();
	}

	private enqueueRegistryUpdate(): Promise<void> {
		if (!this.started || this.disposed) return Promise.resolve();
		this.pendingRegistryUpdate = true;
		if (this.registryDrain) return this.registryDrain;
		const drain = (async () => {
			// Batch synchronous setters; retain only one dirty flag during slow I/O.
			await Promise.resolve();
			while (this.pendingRegistryUpdate && this.started && !this.disposed) {
				this.pendingRegistryUpdate = false;
				this.record.lastSeenAt = this.now();
				try {
					const state = await this.stateStore.upsert(cloneRecord(this.record));
					this.registryWarningShown = false;
					await this.applyState(state, false);
				} catch {
					this.warnRegistryFailure();
				}
			}
		})();
		this.registryDrain = drain;
		this.registryQueue = drain;
		void drain.then(
			() => {
				if (this.registryDrain !== drain) return;
				this.registryDrain = undefined;
				if (this.pendingRegistryUpdate && this.started && !this.disposed) {
					void this.enqueueRegistryUpdate();
				}
			},
			() => { if (this.registryDrain === drain) this.registryDrain = undefined; },
		);
		return drain;
	}

	private async applyState(
		state: PresenceState,
		waitForPresence: boolean,
		force = false,
	): Promise<void> {
		if (this.disposed) return;
		const shouldPublish = state.publisherId === this.sessionId;
		if (!shouldPublish) {
			this.publisher = false;
			this.clearRetryTimer();
			this.clearPublishTimer();
			this.pendingPresenceForce = false;
			this.pendingPresenceState = undefined;
			this.lastPublishedActivity = undefined;
			await this.closeTransport();
			this.status = "standby";
			return;
		}

		this.publisher = true;
		this.publisherGeneration = state.publisherGeneration;
		const publish = this.enqueuePresencePublish(state, force);
		if (waitForPresence) await publish;
	}

	private enqueuePresencePublish(
		state: PresenceState,
		force = false,
	): Promise<void> {
		this.pendingPresenceState = state;
		this.pendingPresenceForce ||= force;
		if (force) this.clearPublishTimer();
		if (this.presenceDrain) return this.presenceDrain;

		const drain = (async () => {
			while (this.pendingPresenceState && !this.disposed && this.publisher) {
				const now = this.now();
				const delay = Math.max(
					0,
					this.rateLimitBackoffUntil - now,
					this.pendingPresenceForce ? 0 : this.lastPublishTime + this.minPublishIntervalMs - now,
				);
				if (delay > 0) {
					// A timer owns deferred work; never keep a drain awaiting an unref'ed
					// sleep or restart it in a microtask loop while backoff is active.
					if (!this.publishThrottleTimer) {
						this.publishThrottleTimer = setTimeout(() => {
							this.publishThrottleTimer = undefined;
							if (this.pendingPresenceState && !this.disposed && this.publisher) {
								void this.enqueuePresencePublish(this.pendingPresenceState);
							}
						}, delay);
						this.publishThrottleTimer.unref?.();
					}
					break;
				}

				this.clearPublishTimer();
				const nextState = this.pendingPresenceState;
				this.pendingPresenceState = undefined;
				this.pendingPresenceForce = false;
				try {
					await this.publish(nextState);
				} catch {
					// Presence failures are deliberately non-fatal to Pi.
				}
			}
		})();
		this.presenceDrain = drain;
		this.presenceQueue = drain;
		void drain.then(
			() => {
				if (this.presenceDrain !== drain) return;
				this.presenceDrain = undefined;
				if (this.pendingPresenceState && !this.publishThrottleTimer && !this.disposed && this.publisher) {
					void this.enqueuePresencePublish(this.pendingPresenceState);
				}
			},
			() => {
				if (this.presenceDrain === drain) this.presenceDrain = undefined;
			},
		);
		return drain;
	}

	private clearPublishTimer(): void {
		if (this.publishThrottleTimer) clearTimeout(this.publishThrottleTimer);
		this.publishThrottleTimer = undefined;
	}

	private async publish(state: PresenceState): Promise<void> {
		if (!this.started || this.disposed || !this.publisher) return;
		if (!(await this.ensureConnected())) return;
		if (!this.started || this.disposed || !this.publisher) return;
		const transport = this.transport;
		if (!transport || !transport.isConnected()) return;

		let didPublish: boolean | undefined;
		let transportFailed = false;

		try {
			didPublish = await this.stateStore.withPublisherLock(
				this.sessionId,
				state.publisherGeneration,
				async (assertOwnership) => {
					if (
						!this.started ||
						this.disposed ||
						!this.publisher ||
						this.transport !== transport ||
						!transport.isConnected()
					) {
						return false;
					}
					await assertOwnership();
					if (this.readPrivacyMode) {
						this.privacyMode = await this.readPrivacyMode();
						await assertOwnership();
					}
					const activity = buildAggregateActivity(state, {
						privacyMode: this.privacyMode,
						showCost: this.showCost,
						clientId: this.clientId,
						enableButtons: this.enableButtons,
						enableAssets: this.enableAssets,
						largeImageKey: this.largeImageKey,
						smallImageKey: this.smallImageKey,
					});
					if (
						isActivityEqual(this.lastPublishedActivity, activity) &&
						this.now() - this.lastPublishTime < PRESENCE_REASSERT_INTERVAL_MS
					) {
						return true;
					}
					const sendActivity = async (): Promise<void> => {
						await awaitWithTimeout(
							transport.setActivity(activity),
							RPC_WRITE_TIMEOUT_MS,
						);
					};

					const deferRateLimit = (): void => {
						this.consecutiveRateLimits += 1;
						this.rateLimitBackoffUntil =
							this.now() +
							Math.min(
								RETRY_CAP_MS,
								RATE_LIMIT_BACKOFF_MS * 2 ** (this.consecutiveRateLimits - 1),
							);
						// Do not replace a newer update received while this RPC was pending.
						this.pendingPresenceState ??= state;
					};

					try {
						await sendActivity();
					} catch (transportErr) {
						if (isRateLimitError(transportErr)) {
							deferRateLimit();
							return true;
						}

						// A connected transport can recover from a transient write error
						// without paying a reconnect delay. Retry once; persistent failures
						// still take the normal unavailable path below.
						if (!transport.isConnected()) {
							transportFailed = true;
							throw transportErr;
						}

						try {
							await sendActivity();
						} catch (retryErr) {
							if (isRateLimitError(retryErr)) {
								deferRateLimit();
								return true;
							}
							transportFailed = true;
							throw retryErr;
						}
					}

					this.lastPublishedActivity = activity;
					this.lastPublishTime = this.now();
					this.consecutiveRateLimits = 0;
					return true;
				},
			);
		} catch (error) {
			if (transportFailed) {
				await this.handleUnavailable(transport);
			} else if (isRegistryLockError(error)) {
				this.warnRegistryFailure();
			} else if (this.transport === transport && !transport.isConnected()) {
				await this.handleUnavailable(transport);
			} else {
				this.warnRegistryFailure();
			}
			return;
		}

		if (didPublish) {
			this.status = "connected";
			this.retryAttempt = 0;
			this.outageWarningShown = false;
			this.clearRetryTimer();
		}
	}

	private async ensureConnected(): Promise<boolean> {
		if (this.disposed || !this.started || !this.publisher) return false;
		if (this.transport?.isConnected()) return true;
		if (this.connectionPromise) return this.connectionPromise;
		// Heartbeats and tool updates must not bypass a pending reconnect delay.
		if (this.retryTimer) return false;

		const promise = this.openTransport();
		this.connectionPromise = promise;
		try {
			return await promise;
		} finally {
			if (this.connectionPromise === promise) this.connectionPromise = undefined;
		}
	}

	private async openTransport(): Promise<boolean> {
		if (this.disposed || !this.started || !this.publisher) return false;
		await this.closeTransport();
		let transport: DiscordPresenceTransport;
		try {
			transport = await this.createTransport(this.clientId);
		} catch (error) {
			if (!this.transportErrorWarningShown) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger(`[discord-presence] ${message}`);
				this.transportErrorWarningShown = true;
			}
			await this.handleUnavailable();
			return false;
		}

		this.transport = transport;
		this.removeDisconnectedListener = transport.onDisconnected?.(() => {
			if (this.transport !== transport || this.disposed || !this.publisher) return;
			void this.handleUnavailable(transport);
		});
		this.status = "connecting";
		try {
			await transport.connect();
			if (
				this.disposed ||
				!this.publisher ||
				this.transport !== transport ||
				!transport.isConnected()
			) {
				await this.closeTransport(transport);
				return false;
			}
			this.transportErrorWarningShown = false;
			return true;
		} catch (error) {
			if (!this.transportErrorWarningShown) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger(`[discord-presence] ${message}`);
				this.transportErrorWarningShown = true;
			}
			await this.handleUnavailable(transport);
			return false;
		}
	}

	private async handleUnavailable(
		expectedTransport?: DiscordPresenceTransport,
	): Promise<void> {
		if (
			this.disposed ||
			!this.started ||
			!this.publisher ||
			(expectedTransport && this.transport !== expectedTransport)
		)
			return;
		this.status = "reconnecting";
		if (!this.outageWarningShown) {
			this.logger(
				"[discord-presence] Discord Desktop is unavailable; retrying in the background.",
			);
			this.outageWarningShown = true;
		}
		await this.closeTransport(expectedTransport);
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.disposed || !this.started || !this.publisher || this.retryTimer)
			return;
		const delay = Math.min(
			this.retryCapMs,
			this.retryBaseMs * 2 ** this.retryAttempt,
		);
		this.retryAttempt = Math.min(this.retryAttempt + 1, 30);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.refresh();
		}, delay);
		this.retryTimer.unref?.();
	}

	private clearRetryTimer(): void {
		if (!this.retryTimer) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	private async closeTransport(
		expectedTransport?: DiscordPresenceTransport,
	): Promise<void> {
		const transport = this.transport;
		if (expectedTransport && transport !== expectedTransport) return;
		this.transport = undefined;
		this.lastPublishedActivity = undefined;
		const removeDisconnectedListener = this.removeDisconnectedListener;
		this.removeDisconnectedListener = undefined;
		removeDisconnectedListener?.();
		if (!transport) return;
		try {
			await transport.close();
		} catch {
			// Cleanup is best effort.
		}
	}

	private warnRegistryFailure(): void {
		this.status = this.publisher ? "reconnecting" : "standby";
		if (this.registryWarningShown) return;
		this.registryWarningShown = true;
		this.logger(
			"[discord-presence] Shared session registry is unavailable; retrying.",
		);
	}
}

function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function formatDiagnosticSession(record: SessionRecord, now: number): string {
	const model = formatModelLabel(
		record.provider,
		record.modelId,
		record.thinkingLevel,
	);
	const action = formatAction(
		record.action,
		record.phase,
		record.activeSubagents ?? 0,
	);
	const context =
		record.context?.percent === null || record.context?.percent === undefined
			? "ctx ?"
			: `ctx ${Math.round(record.context.percent)}%`;
	const breakdown = `in ${formatTokenCount(record.usage.input)} / out ${formatTokenCount(record.usage.output)}`;
	const project = truncateText(record.projectName, 96) || "project";
	return `${project} · ${model} · ${action} · ${formatTokenCount(record.usage.total)} tok (${breakdown}) · ${formatCost(record.usage)} · ${context} · ${formatDuration(now - record.startedAt)}`;
}
