// What a cache Durable Object hands out, logged once a minute. A Durable Object has 128 MB, and every reply is a
// copy of what it keeps, so the bytes it sends show what fills its memory when many callers ask at once.

const LOG_EVERY_MS = 60_000;
/** A kept value bigger than this is logged when it's kept. */
const BIG_VALUE = 256 * 1024;

export class Traffic {
	private calls = 0;
	private bytes = 0;
	private readonly byKind = new Map<string, number>();
	private largest = { kind: "", bytes: 0 };
	private since = Date.now();

	constructor(private readonly label: () => string) {}

	/** One reply of `bytes`, of a kind such as "view:claims-advice" or "state". */
	sent(kind: string, bytes: number) {
		this.calls++;
		this.bytes += bytes;
		this.byKind.set(kind, (this.byKind.get(kind) ?? 0) + bytes);
		if (bytes > this.largest.bytes) this.largest = { kind, bytes };
		if (Date.now() - this.since >= LOG_EVERY_MS) this.log();
	}

	/** A value kept, logged when it's big. */
	kept(kind: string, bytes: number) {
		if (bytes > BIG_VALUE) console.log(`${this.label()} keeps ${kind}: ${kilobytes(bytes)}`);
	}

	private log() {
		const kinds = [...this.byKind]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([kind, bytes]) => `${kind} ${kilobytes(bytes)}`);
		const seconds = Math.round((Date.now() - this.since) / 1000);
		console.log(
			`${this.label()} sent ${kilobytes(this.bytes)} in ${this.calls} replies in ${seconds} s ` +
				`(${kinds.join(", ")}; largest ${this.largest.kind} ${kilobytes(this.largest.bytes)})`,
		);
		this.calls = 0;
		this.bytes = 0;
		this.byKind.clear();
		this.largest = { kind: "", bytes: 0 };
		this.since = Date.now();
	}
}

function kilobytes(bytes: number) {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** A Durable Object's name for the logs, or its id when it was made without one. */
export const objectLabel = (ctx: DurableObjectState) => ctx.id?.name ?? ctx.id?.toString() ?? "a cache";
