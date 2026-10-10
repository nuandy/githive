export interface RetryTransientOptions {
	/** Total attempts, including the first. */
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	/** Defaults to isTransientFailure. */
	retryable?: (error: unknown) => boolean;
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);
const TRANSIENT_NETWORK_CODES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"ERR_SOCKET_CONNECTION_TIMEOUT",
	"ERR_NETWORK",
]);

function recordOf(value: unknown): Record<string, unknown> | undefined {
	if ((typeof value === "object" && value !== null) || typeof value === "function") {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function numericStatus(value: unknown): number | undefined {
	let status = NaN;
	if (typeof value === "number") status = value;
	else if (typeof value === "string" && /^\d{3}$/.test(value)) status = Number(value);
	return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Collect status fields found on an error, its cause chain, and common HTTP wrappers. */
function statusesOf(error: unknown): number[] {
	const statuses: number[] = [];
	const queue: unknown[] = [error];
	const visited = new Set<object>();

	while (queue.length > 0) {
		const record = recordOf(queue.pop());
		if (!record || visited.has(record)) continue;
		visited.add(record);

		for (const key of ["status", "statusCode", "httpStatus", "httpStatusCode"]) {
			const status = numericStatus(record[key]);
			if (status !== undefined) statuses.push(status);
		}

		for (const key of ["cause", "response", "data"]) {
			const nested = record[key];
			if (nested !== undefined && nested !== null) queue.push(nested);
		}
	}

	return statuses;
}

function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	const visited = new Set<object>();
	let current: unknown = error;

	while (current !== undefined && current !== null) {
		const record = recordOf(current);
		if (!record) break;
		if (visited.has(record)) break;
		visited.add(record);
		chain.push(current);
		current = record.cause;
	}

	return chain;
}

function hasRecognizableNetworkFailure(error: unknown): boolean {
	for (const item of causeChain(error)) {
		const record = recordOf(item);
		if (!record) continue;

		const code = record.code;
		if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code.toUpperCase())) return true;

		const name = record.name;
		if (typeof name === "string" && ["TimeoutError", "NetworkError"].includes(name)) return true;

		const message = typeof record.message === "string" ? record.message : "";
		if (/\b(?:timed?\s*out|timeout)\b/i.test(message)) return true;
		if (/\b(?:fetch failed|failed to fetch|network error|network connection (?:was )?lost)\b/i.test(message))
			return true;
		if (/\b(?:socket hang up|connection (?:was )?(?:reset|refused|aborted|timed? out)|broken pipe)\b/i.test(message))
			return true;
		if (/\btemporary failure in name resolution\b/i.test(message)) return true;
	}

	return false;
}

/**
 * Whether a failure is likely to clear on another attempt. An explicit non-transient HTTP
 * status wins over a network-looking message on the same error.
 */
export function isTransientFailure(error: unknown): boolean {
	// Errors already retried at a lower level, such as in git-http.ts, aren't retried again.
	if ((error as { retried?: boolean } | null)?.retried) return false;
	const statuses = statusesOf(error);
	if (statuses.length > 0) {
		return statuses.every((status) => TRANSIENT_HTTP_STATUSES.has(status) || status >= 500);
	}

	return hasRecognizableNetworkFailure(error);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** retryTransient's default backoff after attempt `attempt`, counting from 1. */
export const transientDelay = (attempt: number, baseDelayMs = 100, maxDelayMs = 2000) =>
	Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));

/** Run an operation again only when its failure is explicitly transient. */
export async function retryTransient<T>(operation: () => Promise<T>, options: RetryTransientOptions = {}): Promise<T> {
	const maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.floor(options.maxAttempts!)) : 4;
	const baseDelayMs = Number.isFinite(options.baseDelayMs) ? Math.max(0, options.baseDelayMs!) : 100;
	const maxDelayMs = Number.isFinite(options.maxDelayMs) ? Math.max(0, options.maxDelayMs!) : 2000;
	const wait = options.sleep ?? sleep;

	for (let attempt = 1; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (attempt >= maxAttempts || !(options.retryable ?? isTransientFailure)(error)) throw error;
			await wait(transientDelay(attempt, baseDelayMs, maxDelayMs));
		}
	}
}
