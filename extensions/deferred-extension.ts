import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CoreModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type EventRegistrar = (event: string, handler: EventHandler) => void;
type CoreLoader = () => Promise<CoreModule[]>;

export function registerDeferredCores(
	pi: ExtensionAPI,
	loadCores: CoreLoader = () =>
		Promise.all([
			import("./subscription-usage.ts"),
			import("./discord-presence.ts"),
			import("./live-throughput-status.ts"),
		]),
): Promise<EventHandler[]> {
	const registerEvent = pi.on.bind(pi) as unknown as EventRegistrar;
	const sessionStarts: EventHandler[] = [];

	return loadCores().then(async (cores) => {
		for (const { default: registerCore } of cores) {
			const deferredPi = new Proxy(pi, {
				get(target, property) {
					if (property === "on") {
						return (event: string, handler: EventHandler): void => {
							if (event === "session_start") {
								sessionStarts.push(handler);
								return;
							}
							registerEvent(event, handler);
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as ExtensionAPI;
			await registerCore(deferredPi);
		}
		return sessionStarts;
	});
}
