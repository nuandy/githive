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
