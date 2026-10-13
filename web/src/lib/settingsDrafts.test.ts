import { describe, expect, it } from "vitest";
import { draftFrom } from "./mergeSettings";
import { createDraftStore, dirtySections, draftKey, shownDraft } from "./settingsDrafts";

// Edits in Settings are kept for the session, outside the page: moving to another section or tab and back finds them
// as they were. A section with edits has a dot in the nav, and closing the window with any asks first.

describe("settings drafts", () => {
	it("keep a draft and what it was made from, and say when any has edits", () => {
		const said: boolean[] = [];
		const store = createDraftStore((dirty) => said.push(dirty));
		let heard = 0;
		const stop = store.subscribe(() => (heard += 1));
		store.set("acme/web:github", { draft: { repo: "x" }, base: { repo: "" }, dirty: true });
		expect(store.get("acme/web:github")).toEqual({ draft: { repo: "x" }, base: { repo: "" }, dirty: true });
		expect(store.anyDirty()).toBe(true);
		store.set("acme/web:github", undefined);
		expect(store.get("acme/web:github")).toBeUndefined();
		expect(store.anyDirty()).toBe(false);
		// Told only as it changes.
		store.set("acme/web:checks", { draft: 1, base: 1, dirty: false });
		expect(said).toEqual([true, false]);
		stop();
		store.set("acme/web:github", undefined);
		expect(heard).toBe(3);
	});

	it("show the draft kept, or what the server says once there are no edits to keep", () => {
		const fresh = { repo: "acme/shop" };
		expect(shownDraft(undefined, fresh)).toEqual({ draft: fresh, base: fresh, dirty: false });
		const editing = { draft: { repo: "acme/x" }, base: { repo: "acme/old" }, dirty: true };
		expect(shownDraft(editing, fresh)).toBe(editing);
		// No edits, and the server has changed since: follow it.
		expect(shownDraft({ draft: { repo: "acme/old" }, base: { repo: "acme/old" }, dirty: false }, fresh)).toEqual({
			draft: fresh,
			base: fresh,
			dirty: false,
		});
	});

	it("put a dot by each section with edits", () => {
		const store = createDraftStore();
		const base = draftFrom({ required: 1, vetoes: [] }, ["npm test"]);
		store.set(draftKey("acme/web", "merge"), { draft: { ...base, required: "2" }, base, dirty: true });
		store.set(draftKey("acme/web", "branch-rules"), { draft: [], base: [], dirty: false });
		store.set(draftKey("acme/web", "github"), { draft: {}, base: {}, dirty: true });
		store.set(draftKey("acme/other", "github"), { draft: {}, base: {}, dirty: true });
		expect([...dirtySections(store, "acme/web")]).toEqual(["review", "github"]);
		expect([...dirtySections(store, "acme/none")]).toEqual([]);
	});
});
