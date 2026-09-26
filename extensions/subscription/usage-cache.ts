/** Usage payload normalization and the session-shared disk cache. */
import fs from "node:fs";
import path from "node:path";
import { agentFilePath } from "../shared/command-kit.ts";
import { asRecord } from "../shared/record-guards.ts";

/** Account balance for pay-as-you-go providers (e.g. the DeepSeek API). */
export interface UsageBalance {
	currency: string;
	total: number;
}

/** Percentages per window key, plus optional plan, reset times (ms epoch), and balance. */
export interface UsageData {
	windows: Record<string, number>;
	plan?: string;
	resets?: Record<string, number>;
	balance?: UsageBalance;
	resetsLeft?: number;
}

interface DiskCacheRecord {
	data: UsageData;
	fetchedAt: number;
}

type DiskCache = Record<string, DiskCacheRecord>;

let cacheFile: string | undefined;
export function getCacheFile(): string {
	return (cacheFile ??= agentFilePath("subscription-usage-cache.json"));
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizePercent(value: unknown): number | undefined {
	const percent = finiteNumber(value);
	return percent === undefined ? undefined : Math.min(100, Math.max(0, percent));
}

function normalizeResets(value: unknown): Record<string, number> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const entries = Object.entries(record).flatMap(([key, reset]) => {
		const value = finiteNumber(reset);
		return value !== undefined && value >= 0 ? [[key, value] as const] : [];
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeBalance(value: unknown): UsageBalance | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const currency =
		typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
	const total = finiteNumber(record.total);
	if (!currency || total === undefined) return undefined;
	return { currency, total };
}

function normalizeResetsLeft(value: unknown): number | undefined {
	const count = finiteNumber(value);
	return count !== undefined && count >= 0 ? Math.floor(count) : undefined;
}

/** Decode provider or disk-cache data before it reaches rendering or scheduling. */
export function normalizeUsageData(value: unknown): UsageData | undefined {
	const record = asRecord(value);
	const windowsRecord = asRecord(record?.windows);
	const balance = normalizeBalance(record?.balance);
	if (!windowsRecord && !balance) return undefined;

	const windows = windowsRecord
		? (Object.fromEntries(
				Object.entries(windowsRecord).flatMap(([key, percent]) => {
					const normalized = normalizePercent(percent);
					return normalized === undefined ? [] : [[key, normalized] as const];
				}),
			) as Record<string, number>)
		: {};
	if (Object.keys(windows).length === 0 && !balance) return undefined;

	const plan = typeof record?.plan === "string" ? record.plan.trim() : undefined;
	const resets = normalizeResets(record?.resets);
	const resetsLeft = normalizeResetsLeft(record?.resetsLeft);
	return {
		windows,
		...(plan ? { plan } : {}),
		...(resets ? { resets } : {}),
		...(balance ? { balance } : {}),
		...(resetsLeft !== undefined ? { resetsLeft } : {}),
	};
}

function normalizeDiskCache(value: unknown): DiskCache {
	const record = asRecord(value);
	if (!record) return {};
	const entries = Object.entries(record).flatMap(([providerId, candidate]) => {
		const cacheRecord = asRecord(candidate);
		const data = normalizeUsageData(cacheRecord?.data);
		const fetchedAt = finiteNumber(cacheRecord?.fetchedAt);
		return data && fetchedAt !== undefined && fetchedAt >= 0
			? [[providerId, { data, fetchedAt }] as const]
			: [];
	});
	return Object.fromEntries(entries);
}

let diskCacheSnapshot: DiskCache = {};
let diskCacheWriteQueue: Promise<void> = Promise.resolve();

export async function loadDiskCache(): Promise<DiskCache> {
	try {
		const raw = await fs.promises.readFile(getCacheFile(), "utf8");
		diskCacheSnapshot = normalizeDiskCache(JSON.parse(raw) as unknown);
	} catch {
		// Keep the last valid snapshot during a partial read or file collision.
	}
	return diskCacheSnapshot;
}

async function persistDiskCache(cache: DiskCache): Promise<void> {
	const filePath = getCacheFile();
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true });
	const contents = JSON.stringify(cache, null, 2);
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, contents, "utf8");
		try {
			await fs.promises.rename(tmp, filePath);
		} catch {
			// Windows cannot always replace an existing file with rename().
			await fs.promises.writeFile(filePath, contents, "utf8");
		}
	} finally {
		await fs.promises.unlink(tmp).catch(() => undefined);
	}
}

export async function saveDiskCache(
	providerId: string,
	data: UsageData,
): Promise<void> {
	const previous = diskCacheWriteQueue;
	const operation = (async () => {
		try {
			await previous;
		} catch {
			// A failed write must not block later cache updates.
		}
		const existing = await loadDiskCache();
		existing[providerId] = {
			data: normalizeUsageData(data) ?? data,
			fetchedAt: Date.now(),
		};
		await persistDiskCache(existing);
		diskCacheSnapshot = existing;
	})();
	diskCacheWriteQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	try {
		await operation;
	} catch (error) {
		console.error("[subscription-usage] failed to write disk cache:", error);
	}
}
