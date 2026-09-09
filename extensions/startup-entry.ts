import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export default function registerStartupEntries(pi: ExtensionAPI): void {
	let coreLoad: Promise<EventHandler[]> | undefined;
	pi.on("session_start", async (event, ctx) => {
		coreLoad ??= import("./deferred-extension.ts").then(({ registerDeferredCores }) =>
			registerDeferredCores(pi),
		);
		for (const handler of await coreLoad) {
			try {
				await handler(event, ctx);
			} catch (error) {
				console.error("[startup-entry] session_start handler failed:", error);
			}
		}
	});
}
