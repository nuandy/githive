/** An error's words as they came, the server's own: to set inside a sentence ("couldn't be loaded: offline"). */
export const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Words as a sentence of their own: a capital to start and a full stop to end, unless they have them. A name at the
 * start (robin/widgets, acme-labs, @acme/team) is kept as it's written.
 */
export function sentence(text: string): string {
	const words = text.trim();
	if (!words) return "";
	const first = words.split(/\s/, 1)[0]!;
	const plainWord = /^[a-z][a-z']*[,:;]?$/.test(first);
	const started = plainWord ? words[0]!.toUpperCase() + words.slice(1) : words;
	return /[.!?…]$/.test(started) ? started : `${started}.`;
}

/** An error from the server, as a sentence for a form or a row to show on its own. */
export const messageOf = (err: unknown) => sentence(reasonOf(err));

/** The HTTP status a call failed with, if it was a call that failed. */
export const statusOf = (err: unknown): number | undefined =>
	err instanceof Error && "status" in err && typeof err.status === "number" ? err.status : undefined;
