import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export default function registerStartupEntries(pi: ExtensionAPI): void {
	let coreLoad: Promise<EventHandler[]> | undefined;
	pi.on("session_start", async (event, ctx) => {
		coreLoad ??= import("./deferred-extension.ts").then(({ registerDeferredCores }) =>
			registerDeferredCores(pi),
		);
		let handlers: EventHandler[];
		try {
			handlers = await coreLoad;
		} catch (error) {
			// Do not cache a failed load: the next session_start retries it.
			coreLoad = undefined;
			console.error("[startup-entry] failed to load extensions:", error);
			return;
		}
		for (const handler of handlers) {
			try {
				await handler(event, ctx);
			} catch (error) {
				console.error("[startup-entry] session_start handler failed:", error);
			}
		}
	});
}
