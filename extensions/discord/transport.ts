import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import { asRecord } from "../shared/record-guards.ts";
import type {
	ClientOptions,
	CommandIncoming,
	SetActivity,
	Transport,
	TransportOptions,
} from "@xhayper/discord-rpc";

export interface DiscordPresenceTransport {
	isConnected(): boolean;
	connect(): Promise<void>;
	setActivity(activity: SetActivity): Promise<void>;
	clearActivity(): Promise<void>;
	close(): Promise<void>;
	onDisconnected?(handler: () => void): () => void;
}

export const TRANSPORT_ENV = "PI_DISCORD_TRANSPORT";
export const NPIPERELAY_ENV = "PI_DISCORD_NPIPERELAY";

export type DiscordTransportMode = "ipc" | "wsl-relay";

/** Detect WSL without treating ordinary Linux as a Windows host. */
export function isWslEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	kernelRelease = os.release(),
): boolean {
	if (platform !== "linux") return false;
	const release = kernelRelease.toLowerCase();
	return Boolean(
		env.WSL_INTEROP ||
			env.WSL_DISTRO_NAME ||
			release.includes("microsoft") ||
			release.includes("wsl"),
	);
}

/** Resolve the RPC transport, allowing an explicit override for unusual setups. */
export function resolveDiscordTransportMode(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	kernelRelease = os.release(),
): DiscordTransportMode {
	const configured = env[TRANSPORT_ENV]?.trim().toLowerCase();
	if (configured === "ipc") return "ipc";
	if (
		configured === "wsl" ||
		configured === "wsl-relay" ||
		configured === "relay" ||
		configured === "npiperelay"
	)
		return "wsl-relay";
	return isWslEnvironment(env, platform, kernelRelease) ? "wsl-relay" : "ipc";
}

const DISCORD_PIPE_COUNT = 10;
const RELAY_CONNECT_TIMEOUT_MS = 1_000;
const MAX_RELAY_PAYLOAD_BYTES = 16 * 1024 * 1024;

function isReadyRpcMessage(message: unknown): boolean {
	const record = asRecord(message);
	return record?.cmd === "DISPATCH" && record.evt === "READY";
}

function isMissingExecutableError(error: unknown): boolean {
	return asRecord(error)?.code === "ENOENT";
}

/**
 * Bridges Discord's Windows named pipe into WSL through npiperelay.exe.
 *
 * WSL cannot open \\.\\pipe\\discord-ipc-* directly. npiperelay is a small
 * Windows executable that copies the pipe bytes to stdin/stdout, so this
 * transport can keep the normal Discord IPC framing and authentication.
 */
export class WslDiscordIpcTransport extends EventEmitter {
	private readonly client: TransportOptions["client"];
	private readonly relayCommand = process.env[NPIPERELAY_ENV]?.trim() || "npiperelay.exe";
	private relay: ChildProcess | undefined;
	private incomingChunks: Buffer[] = [];
	private incomingBytes = 0;
	private connected = false;
	private closing = false;

	/** Compatibility accessor for tests inspecting the buffered incoming stream. */
	get incoming(): Buffer {
		if (this.incomingChunks.length === 0) return Buffer.alloc(0);
		if (this.incomingChunks.length === 1) return this.incomingChunks[0];
		return Buffer.concat(this.incomingChunks, this.incomingBytes);
	}

	set incoming(buffer: Buffer) {
		this.incomingChunks = buffer.length > 0 ? [buffer] : [];
		this.incomingBytes = buffer.length;
	}

	private resetIncoming(): void {
		this.incomingChunks = [];
		this.incomingBytes = 0;
	}

	private readUInt32LE(offset: number): number {
		let currentOffset = offset;
		for (let i = 0; i < this.incomingChunks.length; i++) {
			const chunk = this.incomingChunks[i];
			if (currentOffset < chunk.length) {
				if (currentOffset + 4 <= chunk.length) {
					return chunk.readUInt32LE(currentOffset);
				}
				const temp = Buffer.allocUnsafe(4);
				let bytesCopied = 0;
				let chunkIdx = i;
				let localOffset = currentOffset;
				while (bytesCopied < 4 && chunkIdx < this.incomingChunks.length) {
					const cur = this.incomingChunks[chunkIdx];
					const available = cur.length - localOffset;
					const toCopy = Math.min(4 - bytesCopied, available);
					cur.copy(temp, bytesCopied, localOffset, localOffset + toCopy);
					bytesCopied += toCopy;
					localOffset = 0;
					chunkIdx++;
				}
				return temp.readUInt32LE(0);
			}
			currentOffset -= chunk.length;
		}
		return 0;
	}

	private consumeBytes(count: number): Buffer {
		if (count <= 0) return Buffer.alloc(0);
		this.incomingBytes = Math.max(0, this.incomingBytes - count);
		if (this.incomingChunks.length === 1) {
			const single = this.incomingChunks[0];
			if (single.length === count) {
				this.incomingChunks = [];
				return single;
			}
			const result = single.subarray(0, count);
			this.incomingChunks[0] = single.subarray(count);
			return result;
		}
		const result = Buffer.allocUnsafe(count);
		let copied = 0;
		while (copied < count && this.incomingChunks.length > 0) {
			const head = this.incomingChunks[0];
			const needed = count - copied;
			if (head.length <= needed) {
				head.copy(result, copied);
				copied += head.length;
				this.incomingChunks.shift();
			} else {
				head.copy(result, copied, 0, needed);
				this.incomingChunks[0] = head.subarray(needed);
				copied += needed;
			}
		}
		return result;
	}
	constructor(options: TransportOptions) {
		super();
		this.client = options.client;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		let lastError: unknown;
		for (let pipeId = 0; pipeId < DISCORD_PIPE_COUNT; pipeId += 1) {
			try {
				await this.connectPipe(pipeId);
				return;
			} catch (error) {
				lastError = error;
				if (isMissingExecutableError(error)) {
					throw new Error(
						`WSL Discord support requires npiperelay.exe. Put it on PATH or set ${NPIPERELAY_ENV} to its Windows path.`,
					);
				}
			}
		}

		const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
		throw new Error(
			`Could not connect to Windows Discord through ${this.relayCommand}. Ensure Discord Desktop is running.${detail}`,
		);
	}

	private connectPipe(pipeId: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const pipePath = `//./pipe/discord-ipc-${pipeId}`;
			const relay = spawn(this.relayCommand, ["-ep", pipePath], {
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
			});
			this.relay = relay;

			let settled = false;
			let ready = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const clearAttempt = (): void => {
				if (timer) clearTimeout(timer);
				timer = undefined;
				this.removeListener("message", onMessage);
			};

			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				clearAttempt();
				relay.stdout?.removeListener("data", onData);
				relay.removeListener("spawn", onSpawn);
				relay.removeListener("error", onError);
				relay.removeListener("close", onClose);
				relay.on("error", () => {});
				if (this.relay === relay) {
					this.relay = undefined;
					this.connected = false;
					this.resetIncoming();
				}
				relay.kill();
				reject(error instanceof Error ? error : new Error(String(error)));
			};

			const succeed = (): void => {
				if (settled) return;
				settled = true;
				ready = true;
				this.connected = true;
				clearAttempt();
				resolve();
			};

			const onMessage = (message: unknown): void => {
				if (isReadyRpcMessage(message)) succeed();
			};

			const onData = (chunk: Buffer | string): void => {
				this.handleIncomingData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			};

			const onSpawn = (): void => {
				this.emit("open");
				try {
					this.writePacket({ v: 1, client_id: this.client.clientId }, 0);
				} catch (error) {
					fail(error);
				}
			};

			const onError = (error: Error): void => {
				if (!settled) fail(error);
			};

			const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
				if (!ready) {
					fail(
						new Error(
							`npiperelay exited before Discord IPC became ready (code ${code ?? "none"}, signal ${signal ?? "none"})`,
						),
					);
					return;
				}
				if (this.relay === relay) {
					this.relay = undefined;
					this.connected = false;
					this.resetIncoming();
				}
				if (!this.closing) this.emit("close", "Windows Discord IPC closed");
			};

			this.on("message", onMessage);
			relay.stdout?.on("data", onData);
			relay.once("spawn", onSpawn);
			relay.once("error", onError);
			relay.once("close", onClose);
			timer = setTimeout(() => {
				fail(`Timed out connecting to Discord IPC pipe ${pipeId}`);
			}, RELAY_CONNECT_TIMEOUT_MS);
		});
	}

	private handleIncomingData(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.incomingChunks.push(chunk);
		this.incomingBytes += chunk.length;

		while (this.incomingBytes >= 8) {
			const opcode = this.readUInt32LE(0);
			const payloadLength = this.readUInt32LE(4);
			if (payloadLength > MAX_RELAY_PAYLOAD_BYTES) {
				this.relay?.kill();
				this.resetIncoming();
				return;
			}
			if (this.incomingBytes < payloadLength + 8) return;

			// Consume the 8-byte header and extract the payload
			this.consumeBytes(8);
			const payloadBuf = this.consumeBytes(payloadLength);
			const payload = payloadBuf.toString("utf8");

			let message: unknown;
			try {
				message = JSON.parse(payload);
			} catch {
				this.relay?.kill();
				this.resetIncoming();
				return;
			}

			switch (opcode) {
				case 1:
					this.emit("message", message as CommandIncoming);
					break;
				case 2: {
					let reason: string | { code: number; message: string } | undefined;
					if (typeof message === "string") {
						reason = message;
					} else {
						const record = asRecord(message);
						if (typeof record?.code === "number" && typeof record.message === "string")
							reason = { code: record.code, message: record.message };
					}
					this.emit("close", reason);
					break;
				}
				case 3:
					this.writePacket(message, 4);
					break;
				default:
					break;
			}
		}
	}

	private writePacket(message: unknown, opcode: number): void {
		const stdin = this.relay?.stdin;
		if (!stdin || stdin.destroyed) throw new Error("The npiperelay stdin stream is unavailable");
		const payload = Buffer.from(JSON.stringify(message) ?? "");
		const packet = Buffer.alloc(8);
		packet.writeUInt32LE(opcode, 0);
		packet.writeUInt32LE(payload.length, 4);
		stdin.write(Buffer.concat([packet, payload]));
	}

	send(message?: unknown): void {
		try {
			this.writePacket(message, 1);
		} catch (error) {
			this.emit("close", error instanceof Error ? error.message : String(error));
		}
	}

	ping(): void {
		this.writePacket(randomUUID(), 3);
	}

	async close(): Promise<void> {
		const relay = this.relay;
		this.relay = undefined;
		this.connected = false;
		this.resetIncoming();
		if (!relay) return;

		this.closing = true;
		await new Promise<void>((resolve) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				this.closing = false;
				this.emit("close", "Closed by client");
				resolve();
			};
			relay.once("close", finish);
			relay.once("error", finish);
			if (relay.exitCode !== null) {
				finish();
				return;
			}
			relay.kill();
			timer = setTimeout(() => {
				relay.kill("SIGKILL");
				finish();
			}, 1_000);
			timer.unref?.();
		});
	}
}

export async function createDiscordPresenceTransport(
	clientId: string,
): Promise<DiscordPresenceTransport> {
	const transportMode = resolveDiscordTransportMode();
	// Lazy-load the Discord RPC stack only when a transport is actually needed
	// (session_start on the elected publisher). A static import would make Pi
	// pay the module cost on every startup, even when presence is disabled.
	const { Client } = await import("@xhayper/discord-rpc");
	const clientOptions: ClientOptions =
		transportMode === "wsl-relay"
			? {
					clientId,
					transport: {
						type: WslDiscordIpcTransport as unknown as new (options: TransportOptions) => Transport,
					},
				}
			: { clientId };
	const client = new Client(clientOptions);
	const disconnectHandlers = new Set<() => void>();

	client.on("disconnected", () => {
		for (const handler of disconnectHandlers) handler();
	});

	return {
		isConnected: () => Boolean(client.isConnected && client.user),
		connect: () => client.connect(),
		setActivity: async (activity) => {
			if (!client.user) throw new Error("Discord RPC user is not ready");
			await client.user.setActivity(activity);
		},
		clearActivity: async () => {
			if (client.user) await client.user.clearActivity();
		},
		close: () => client.destroy(),
		onDisconnected: (handler) => {
			disconnectHandlers.add(handler);
			return () => disconnectHandlers.delete(handler);
		},
	};
}
