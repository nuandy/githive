// Errors thrown across Durable Object RPC keep their message but not their
// class, so the HTTP status rides in the message: "[409] slice is not building".
export function fail(status: number, message: string): never {
	throw new Error(`[${status}] ${message}`);
}

export function statusOf(err: unknown): { status: number; message: string } {
	const text = err instanceof Error ? err.message : String(err);
	const match = /^\[(\d{3})\] (.*)$/s.exec(text);
	return match ? { status: Number(match[1]), message: match[2] } : { status: 500, message: text };
}

/**
 * A required string argument, trimmed. Throws `[400] <key> is required` when it
 * is missing or blank. Shared by the HTTP routes and the MCP tools.
 */
export function requiredString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) fail(400, `${key} is required`);
	return value.trim();
}

/** A required list of paths. The paths themselves are checked where they are claimed. */
export function requiredPaths(args: Record<string, unknown>, key: string): string[] {
	const value = args[key];
	if (value === undefined || value === null) fail(400, `${key} is required`);
	return value as string[];
}
