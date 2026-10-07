/** Timeout-bounded JSON requests shared by the usage providers. */
function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!a) return b ?? new AbortController().signal;
	if (!b) return a;
	return AbortSignal.any([a, b]);
}

const FETCH_TIMEOUT_MS = 10_000;

/** Signal for one provider request: the caller's abort plus a hard timeout. */
export function requestSignal(signal?: AbortSignal): AbortSignal {
	return anySignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS));
}

/**
 * One provider request: timeout-bounded, the body drained on a non-2xx status
 * so the socket is released, and an `${errorPrefix}HTTP <status>` error.
 */
export async function fetchJson<T>(
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
	errorPrefix = "",
): Promise<T> {
	const res = await fetch(url, { ...init, signal: requestSignal(signal) });
	if (!res.ok) {
		await res.body?.cancel().catch(() => undefined);
		throw new Error(`${errorPrefix}HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}
