// Errors thrown across Durable Object RPC keep their message but not their
// class, so the HTTP status rides in the message: "[409] slice is not building".
// So does the step an agent can take next, where it's known, on a last line
// "next: ...", which agents see over MCP and statusOf takes off the message.
export function fail(status: number, message: string, next?: string): never {
	// Only fail adds a next line: one inside the message (quoting git's output, say) is defused, so statusOf never
	// takes the rest of the message for the next step.
	const said = message.replaceAll("\nnext: ", "\nnext - ");
	throw new Error(`[${status}] ${said}${next ? `\nnext: ${next}` : ""}`);
}

export function statusOf(err: unknown): { status: number; message: string; next?: string } {
	const text = err instanceof Error ? err.message : String(err);
	const [, status, message, next] = /^\[(\d{3})\] (.*?)(?:\nnext: (.*))?$/s.exec(text) ?? [];
	if (status === undefined || message === undefined) return { status: 500, message: text };
	return { status: Number(status), message, ...(next ? { next } : {}) };
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
