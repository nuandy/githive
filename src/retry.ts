export interface RetryTransientOptions {
	/** Maximum number of total attempts, including the first call. */
	maxAttempts?: number;
	/** Delay before the second attempt, in milliseconds. */
	baseDelayMs?: number;
	/** Upper bound for any backoff delay, in milliseconds. */
	maxDelayMs?: number;
	/** Injectable delay function, useful for tests and custom runtimes. */
	sleep?: (ms: number) => Promise<void>;
	/** Which failures to retry (default: isTransientFailure). */
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
	const status = typeof value === "number" ? value : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : NaN;
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
		if (/\b(?:fetch failed|failed to fetch|network error|network connection (?:was )?lost)\b/i.test(message)) return true;
		if (/\b(?:socket hang up|connection (?:was )?(?:reset|refused|aborted|timed? out)|broken pipe)\b/i.test(message)) return true;
		if (/\btemporary failure in name resolution\b/i.test(message)) return true;
	}

	return false;
}

/**
 * Returns true only for failures that are likely to clear on a subsequent
 * attempt. Explicit non-transient HTTP statuses take precedence over generic
 * network-looking messages on the same wrapped error.
 */
export function isTransientFailure(error: unknown): boolean {
	const statuses = statusesOf(error);
	if (statuses.length > 0) {
		return statuses.every((status) => TRANSIENT_HTTP_STATUSES.has(status) || status >= 500);
	}

	return hasRecognizableNetworkFailure(error);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long retryTransient waits after failed attempt `attempt` (counting from 1), by default. */
export const transientDelay = (attempt: number, baseDelayMs = 100, maxDelayMs = 2000) => Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));

/** Run an operation again only when its failure is explicitly transient. */
export async function retryTransient<T>(
	operation: () => Promise<T>,
	options: RetryTransientOptions = {},
): Promise<T> {
	const maxAttempts = Number.isFinite(options.maxAttempts)
		? Math.max(1, Math.floor(options.maxAttempts!))
		: 4;
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
