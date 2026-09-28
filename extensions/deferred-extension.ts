import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CoreModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type EventRegistrar = (event: string, handler: EventHandler) => void;
/** One loader per core, so a core that fails to import cannot take the others down. */
export type CoreLoader = { name: string; load: () => Promise<CoreModule> };

export const DEFAULT_CORES: readonly CoreLoader[] = [
	{ name: "subscription-usage", load: () => import("./subscription-usage.ts") },
	{ name: "discord-presence", load: () => import("./discord-presence.ts") },
	{ name: "live-throughput-status", load: () => import("./live-throughput-status.ts") },
	{ name: "prompt-rewriter", load: () => import("./prompt-rewriter.ts") },
];

/**
 * Load and register every core, isolating failures: a core whose import or
 * registration throws is logged and skipped, and its session_start handlers
 * are dropped, while the remaining cores keep working.
 */
export async function registerDeferredCores(
	pi: ExtensionAPI,
	cores: readonly CoreLoader[] = DEFAULT_CORES,
	log: (message: string, error: unknown) => void = (message, error) =>
		console.error(message, error),
): Promise<EventHandler[]> {
	const registerEvent = pi.on.bind(pi) as unknown as EventRegistrar;
	const sessionStarts: EventHandler[] = [];
	// Import in parallel, register in declaration order.
	const loaded = await Promise.allSettled(cores.map((core) => core.load()));

	for (const [index, result] of loaded.entries()) {
		const name = cores[index].name;
		if (result.status === "rejected") {
			log(`[startup-entry] failed to load ${name}:`, result.reason);
			continue;
		}
		const coreStarts: EventHandler[] = [];
		const deferredPi = new Proxy(pi, {
			get(target, property) {
				if (property === "on") {
					return (event: string, handler: EventHandler): void => {
						if (event === "session_start") {
							coreStarts.push(handler);
							return;
						}
						registerEvent(event, handler);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as ExtensionAPI;
		try {
			await result.value.default(deferredPi);
			sessionStarts.push(...coreStarts);
		} catch (error) {
			log(`[startup-entry] failed to register ${name}:`, error);
		}
	}
	return sessionStarts;
}
