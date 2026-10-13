import { type MergeDraft, type MergePart, partDirty } from "./mergeSettings";
import type { SettingsSection } from "./routes";

// Edits in a repo's Settings, kept for the session outside any component: a tab or section that unmounts as the address
// changes finds them as they were when it comes back. Each is held with what it was made from (`base`, the server's
// settings then) and whether it differs; while any does, closing or reloading the window asks first.

/** A form's draft, what it was made from, and whether it has edits. */
export interface Held<T> {
	draft: T;
	base: T;
	dirty: boolean;
}

/** The forms held per repo: the merge settings (review, path rules, checks share one), branch rules and GitHub. */
export type DraftForm = "merge" | "branch-rules" | "github";
export const draftKey = (repo: string, form: DraftForm) => `${repo}:${form}`;

export function createDraftStore(onDirty?: (dirty: boolean) => void) {
	const held = new Map<string, Held<unknown>>();
	const listeners = new Set<() => void>();
	let wasDirty = false;
	const anyDirty = () => [...held.values()].some((each) => each.dirty);
	return {
		get: <T>(key: string) => held.get(key) as Held<T> | undefined,
		/** Holds a form's draft, or lets it go (undefined). */
		set<T>(key: string, value: Held<T> | undefined) {
			if (value) held.set(key, value);
			else held.delete(key);
			const dirty = anyDirty();
			if (dirty !== wasDirty) onDirty?.(dirty);
			wasDirty = dirty;
			listeners.forEach((listener) => listener());
		},
		anyDirty,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}

export type DraftStore = ReturnType<typeof createDraftStore>;

/** What a form shows: the draft held while it has edits, or else the server's settings as they are now (`fresh`). */
export function shownDraft<T>(held: Held<T> | undefined, fresh: T): Held<T> {
	if (held && (held.dirty || JSON.stringify(held.base) === JSON.stringify(fresh))) return held;
	return { draft: fresh, base: fresh, dirty: false };
}

/** The sections of a repo's Settings with edits not yet saved. */
export function dirtySections(store: DraftStore, repo: string): Set<SettingsSection> {
	const dirty = new Set<SettingsSection>();
	const merge = store.get<MergeDraft>(draftKey(repo, "merge"));
	if (merge?.dirty)
		for (const part of ["review", "path-rules", "checks"] satisfies MergePart[])
			if (partDirty(part, merge.draft, merge.base)) dirty.add(part);
	for (const form of ["branch-rules", "github"] as const) if (store.get(draftKey(repo, form))?.dirty) dirty.add(form);
	return dirty;
}

/** Asks before the window closes or reloads while there are edits; a browser shows its own words. */
function guardUnload(dirty: boolean) {
	if (typeof window === "undefined") return;
	if (dirty) window.addEventListener("beforeunload", warn);
	else window.removeEventListener("beforeunload", warn);
}
function warn(event: BeforeUnloadEvent) {
	event.preventDefault();
	// Older browsers ask only when this is set.
	event.returnValue = "";
}

/** The dashboard's drafts, for the session. */
export const settingsDrafts = createDraftStore(guardUnload);
