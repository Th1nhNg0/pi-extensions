/** Config shapes shared by every usage provider. */
import type { UsageStyle } from "./rendering.ts";
import type { UsageData } from "./usage-cache.ts";

/** A provider with a quota API: fetched on a schedule and rendered in the footer. */
export interface PolledProviderCfg {
	id: string;
	fetchUsage: (signal?: AbortSignal) => Promise<UsageData>;
	render: (
		data: UsageData,
		theme: { fg(color: string, text: string): string },
		modelId?: string,
		style?: UsageStyle,
	) => string;
}

/** Subscription providers without a documented quota API use a settings link, never polling. */
export interface LinkedProviderCfg {
	id: string;
	usageLink: string;
}

export type ProviderCfg = PolledProviderCfg | LinkedProviderCfg;
