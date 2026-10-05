/**
 * Shared /goal-style menus for the extensions in this package.
 *
 * Pi Goal opens an interactive TUI menu for bare `/goal`; every command here
 * does the same for its bare form. The menus are built from the same
 * pi-tui-kit primitives Pi Goal uses — declarative screens, current-value
 * settings rows, standard hints, Esc/Back navigation, and cancellation — so
 * all five commands navigate and render identically.
 *
 * pi-tui-kit (and the Pi TUI it imports) loads through a dynamic import on the
 * first menu open: sessions and the node test suite start without paying for
 * the TUI runtime, and RPC, print, and JSON sessions never load it at all.
 * `menuSupported` is the single gate; when it is false the caller keeps its
 * text fallback, exactly like Pi Goal.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition, RunMenuResult } from "@narumitw/pi-tui-kit";

export type MenuKit = typeof import("@narumitw/pi-tui-kit");

/** The context fields the capability check reads; test fakes set only some. */
export interface MenuCapabilityContext {
	mode?: ExtensionContext["mode"];
	hasUI?: boolean;
	ui?: { custom?: unknown };
}

/**
 * Menus need Pi's interactive TUI: TUI mode, a UI, and `ui.custom` to host the
 * menu component. RPC, print, and JSON keep each command's text fallback, and
 * the test fakes (no `ui.custom`) exercise that fallback.
 */
export function menuSupported(ctx: MenuCapabilityContext): boolean {
	return ctx.hasUI === true && ctx.mode === "tui" && typeof ctx.ui?.custom === "function";
}

let kitPromise: Promise<MenuKit> | undefined;

/** Load pi-tui-kit once; a failed import is retried on the next menu open. */
export function loadMenuKit(): Promise<MenuKit> {
	kitPromise ??= import("@narumitw/pi-tui-kit").catch((error: unknown) => {
		kitPromise = undefined;
		throw error;
	});
	return kitPromise;
}

export interface MenuRunOptions<State> {
	/** Snapshot of the extension state; re-read on every screen entry. */
	getState(ctx: ExtensionCommandContext, signal: AbortSignal): State | Promise<State>;
	/** Report a failed action; defaults to a notification. */
	onError?(ctx: ExtensionCommandContext, error: unknown): void;
}

/**
 * Build and run one menu. `build` receives the dynamically imported kit so the
 * definition stays lazily loaded; the result mirrors pi-tui-kit's `runMenu`.
 */
export async function showExtensionMenu<State, ScreenId extends string, ActionId extends string>(
	ctx: ExtensionCommandContext,
	build: (kit: MenuKit) => MenuDefinition<State, ScreenId, ActionId>,
	options: MenuRunOptions<State>,
): Promise<RunMenuResult> {
	let kit: MenuKit;
	try {
		kit = await loadMenuKit();
	} catch (error) {
		ctx.ui.notify(`Could not load the settings menu: ${formatError(error)}`, "error");
		return { kind: "error", error };
	}
	return kit.runMenu(ctx, build(kit), {
		getState: ({ ctx: menuCtx, signal }) => options.getState(menuCtx, signal),
		onError: (menuCtx, error) => {
			if (options.onError) {
				options.onError(menuCtx, error);
				return;
			}
			menuCtx.ui.notify(`Settings menu failed: ${formatError(error)}`, "error");
		},
		onUnsupportedMode: (menuCtx, mode) => {
			menuCtx.ui.notify(`The settings menu is unavailable in ${mode} mode.`, "warning");
		},
	});
}

/** Human-readable error text for notifications. */
export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
