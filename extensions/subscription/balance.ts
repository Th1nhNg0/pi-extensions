/** Account balance parsing and compact display helpers. */
import { asRecord } from "../shared/record-guards.ts";
import type { UsageBalance } from "./usage-cache.ts";

const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: "$",
	CNY: "¥",
	EUR: "€",
	GBP: "£",
	JPY: "¥",
};

/** Compact balance label, e.g. `$12.34`, or `12.34 SGD` for unknown currencies. */
export function formatBalance(balance: UsageBalance): string {
	const amount = balance.total.toFixed(2);
	const symbol = CURRENCY_SYMBOLS[balance.currency];
	return symbol ? `${symbol}${amount}` : `${amount} ${balance.currency}`;
}

export interface DeepSeekBalanceResponse {
	balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>;
}

export function parseDeepSeekBalance(json: DeepSeekBalanceResponse): UsageBalance {
	// Prefer USD when the account holds several currencies.
	const balances = (json.balance_infos ?? []).flatMap((entry) => {
		const record = asRecord(entry);
		const currency =
			typeof record?.currency === "string" ? record.currency.trim().toUpperCase() : "";
		const total = Number.parseFloat(String(record?.total_balance ?? ""));
		return currency && Number.isFinite(total) ? [{ currency, total }] : [];
	});
	const balance = balances.find((entry) => entry.currency === "USD") ?? balances[0];
	if (!balance) throw new Error("no balance data");
	return balance;
}
