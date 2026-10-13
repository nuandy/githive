import { useSyncExternalStore } from "react";
import { type DraftStore, type Held, shownDraft } from "../lib/settingsDrafts";

/**
 * A form's draft, held in `store` under `key` so it outlives the form: what it shows (the draft held while it has edits,
 * else `fresh`, the server's settings now), `edit` to change it, `reset` once saved, and `discard`. `isDirty` says
 * whether a draft differs from what it was made from.
 */
export function useHeldDraft<T>(
	store: DraftStore,
	key: string,
	fresh: T,
	isDirty: (draft: T, base: T) => boolean,
): Held<T> & { edit(change: (draft: T) => T): void; reset(base: T, draft?: T): void; discard(): void } {
	const read = () => store.get<T>(key);
	const held = useSyncExternalStore(store.subscribe, read, read);
	const now = () => shownDraft(read(), fresh);
	return {
		...shownDraft(held, fresh),
		edit(change) {
			const { draft, base } = now();
			const next = change(draft);
			store.set(key, { draft: next, base, dirty: isDirty(next, base) });
		},
		reset(base, draft = base) {
			store.set(key, { draft, base, dirty: isDirty(draft, base) });
		},
		discard: () => store.set(key, undefined),
	};
}
