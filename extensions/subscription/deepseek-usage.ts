/** DeepSeek API provider config: account balance plus peak/off-peak billing state. */
import { formatBalance, parseDeepSeekBalance } from "./balance.ts";
import type { DeepSeekBalanceResponse } from "./balance.ts";
import { USAGE_CREDENTIAL_ENV, resolveApiKey } from "./credentials.ts";
import { fetchJson } from "./http.ts";
import type { PolledProviderCfg } from "./provider-config.ts";
import { joinParts } from "./rendering.ts";
import { deepSeekPeakTag } from "./usage-windows.ts";

/** DeepSeek API (pay-as-you-go): account balance plus peak/off-peak billing state. */
export const deepseekCfg: PolledProviderCfg = {
	id: "deepseek",
	async fetchUsage(signal?: AbortSignal) {
		const key = resolveApiKey("deepseek", USAGE_CREDENTIAL_ENV.deepseek);
		const json = await fetchJson<DeepSeekBalanceResponse>(
			"https://api.deepseek.com/user/balance",
			{ headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
			signal,
		);
		const balance = parseDeepSeekBalance(json);
		return { windows: {}, balance };
	},
	render(data, theme) {
		const parts = [deepSeekPeakTag(theme)];
		if (data.balance) parts.push(formatBalance(data.balance));
		return joinParts(parts, theme);
	},
};
