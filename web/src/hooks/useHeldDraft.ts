import { useEffect, useSyncExternalStore } from "react";
import { type DraftStore, type Held, sameSettings, shownDraft } from "../lib/settingsDrafts";

/**
 * A form's draft, held in `store` under `key` so it outlives the form: what it shows (the draft held while it has edits,
 * else `fresh`, the server's settings now; `follow` lets a form in parts show them in the parts without edits), `edit`
 * to change it, `saved` once saved, and `discard`. `isDirty` says whether a draft differs from what it was made from.
 */
export function useHeldDraft<T>(
	store: DraftStore,
	key: string,
	fresh: T,
	isDirty: (draft: T, base: T) => boolean,
	follow?: (held: Held<T>, fresh: T) => Held<T>,
): Held<T> & {
	edit(change: (draft: T) => T): void;
	/**
	 * Once saved: what was saved (`base`) is what the draft is made from, and the draft is what `next` makes of the one
	 * held now (edits made while it saved among them), or else what was saved. Until the server's settings are read
	 * again, the form shows these, not `fresh` as it was.
	 */
	saved(base: T, next?: (current: Held<T>) => T): void;
	discard(): void;
} {
	const read = () => store.get<T>(key);
	const held = useSyncExternalStore(store.subscribe, read, read);
	const now = () => shownDraft(read(), fresh, follow);
	const hold = (draft: T, base: T, against: T | undefined) =>
		store.set(key, { draft, base, dirty: isDirty(draft, base), ...(against === undefined ? {} : { against }) });
	// Once the server's settings are read again, a save's `against` has done its work. Let it go, so settings that come
	// back to what they were before the save show as they are, not as saved.
	const readAgain = held?.against !== undefined && !sameSettings(held.against, fresh);
	useEffect(() => {
		const current = read();
		if (!readAgain || !current) return;
		const { against: _, ...rest } = current;
		store.set(key, rest);
	}, [readAgain, key]);
	return {
		...shownDraft(held, fresh, follow),
		edit(change) {
			const { draft, base, against } = now();
			hold(change(draft), base, against);
		},
		saved(base, next = () => base) {
			hold(next(now()), base, fresh);
		},
		// Back to what the draft was made from: the server's settings, or what was saved until they're read again.
		discard() {
			const { base, against } = now();
			if (against === undefined) store.set(key, undefined);
			else hold(base, base, against);
		},
	};
}
