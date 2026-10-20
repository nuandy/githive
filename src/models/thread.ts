// A hosted agent's conversation with its model, in its own storage: the entries its model's adapter appended, oldest
// first, under the provider and model they were made with. A storage value holds at most 128 KiB, so an entry is kept
// as JSON split into parts.

const PREFIX = "thread:";
const PART_CHARS = 60_000;
/** Which provider and model the entries were made with: another can't continue them. */
const MADE_WITH = "thread-made-with";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;

/** Each entry as its JSON text, which crosses RPC whatever the provider's shape, when a thread is handed on. */
export interface Thread {
	madeWith: string;
	entries: string[];
}

const entryKey = (index: number, part: number) =>
	`${PREFIX}${String(index).padStart(6, "0")}:${String(part).padStart(4, "0")}`;

/** The conversation kept so far, or none. */
export async function loadThread(storage: Storage): Promise<Thread | null> {
	const madeWith = await storage.get<string>(MADE_WITH);
	if (!madeWith) return null;
	const parts = await storage.list<string>({ prefix: PREFIX });
	const byEntry = new Map<string, string[]>();
	for (const [key, part] of parts) {
		const entry = key.slice(PREFIX.length, PREFIX.length + 6);
		byEntry.set(entry, [...(byEntry.get(entry) ?? []), part]);
	}
	const entries = [...byEntry.values()].map((parts) => parts.join(""));
	return { madeWith, entries };
}

/** Appends `entries`, each its JSON text, to the conversation `madeWith` names, starting it when there's none. */
export async function appendThread(storage: Storage, madeWith: string, from: number, entries: string[]) {
	const writes: Record<string, string> = {};
	entries.forEach((json, offset) => {
		for (let part = 0; part * PART_CHARS < json.length || part === 0; part++)
			writes[entryKey(from + offset, part)] = json.slice(part * PART_CHARS, (part + 1) * PART_CHARS);
	});
	await storage.put({ ...writes, [MADE_WITH]: madeWith });
}

/** Forgets the conversation. */
export async function clearThread(storage: Storage) {
	const keys = [...(await storage.list({ prefix: PREFIX })).keys()];
	// Storage deletes at most 128 keys in one call.
	for (let start = 0; start < keys.length; start += 128) await storage.delete(keys.slice(start, start + 128));
	await storage.delete(MADE_WITH);
}

/** What a thread is made with, as kept: provider and model, so a settings change starts a new conversation. */
export const madeWith = (settings: { provider: string; model: string; baseUrl?: string }) =>
	[settings.provider, settings.baseUrl ?? "", settings.model].join(" ");
