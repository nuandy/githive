// Errors thrown across Durable Object RPC keep their message but not their
// class, so the HTTP status rides in the message: "[409] slice is not building".
export function fail(status: number, message: string): never {
	throw new Error(`[${status}] ${message}`);
}

export function statusOf(err: unknown): { status: number; message: string } {
	const text = err instanceof Error ? err.message : String(err);
	const [, status, message] = /^\[(\d{3})\] (.*)$/s.exec(text) ?? [];
	if (status === undefined || message === undefined) return { status: 500, message: text };
	return { status: Number(status), message };
}

/** A required string argument, trimmed. Throws `[400] <key> is required` when it is missing or blank. */
export function requiredString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) fail(400, `${key} is required`);
	return value.trim();
}

/** An optional string argument, trimmed; undefined when it is missing or blank. */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A required list of paths. The paths themselves are checked where they are claimed. */
export function requiredPaths(args: Record<string, unknown>, key: string): string[] {
	const value = args[key];
	if (value === undefined || value === null) fail(400, `${key} is required`);
	return value as string[];
}
