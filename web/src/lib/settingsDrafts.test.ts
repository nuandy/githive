import { describe, expect, it } from "vitest";
import { draftFrom, partDirty, partInput, rebase, withFresh } from "./mergeSettings";
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

	it("show what was saved until the server's settings are read again, then follow them", () => {
		const before = { required: "2" };
		const saved = { required: "3" };
		const held = { draft: saved, base: saved, dirty: false, against: before };
		// The repo isn't read again yet: what was saved, not the settings from before it.
		expect(shownDraft(held, before)).toBe(held);
		// Read again: the server's settings as they are now, whatever they are.
		expect(shownDraft(held, saved)).toEqual({ draft: saved, base: saved, dirty: false });
		expect(shownDraft(held, { required: "4" })).toEqual({
			draft: { required: "4" },
			base: { required: "4" },
			dirty: false,
		});
		// Edits made since are kept either way.
		const edited = { draft: { required: "5" }, base: saved, dirty: true, against: before };
		expect(shownDraft(edited, before)).toBe(edited);
		expect(shownDraft(edited, { required: "4" })).toEqual({ draft: { required: "5" }, base: saved, dirty: true });
	});

	it("let a merge section without edits follow the server while another has some", () => {
		const policy = {
			required: 2,
			vetoes: ["security"],
			escalate: [{ paths: ["src/payments/"], vetoes: ["payments"] }],
		};
		const base = draftFrom(policy, ["npm test"]);
		// Checks edited; since then, an agent made Review need 4 approvals.
		const held = { draft: { ...base, verify: ["npm test", "npm run lint"] }, base, dirty: true };
		const fresh = draftFrom({ ...policy, required: 4 }, ["npm test"]);
		const shown = shownDraft(held, fresh, withFresh);
		expect(shown.draft.required).toBe("4");
		expect(shown.draft.verify).toEqual(["npm test", "npm run lint"]);
		expect(shown.dirty).toBe(true);
		expect(partDirty("review", shown.draft, shown.base)).toBe(false);
		expect(partDirty("checks", shown.draft, shown.base)).toBe(true);
		// Saving Review now sends the server's 4, not the 2 it had when Checks was edited; discarding Checks goes back
		// to the checks it was made from.
		expect(partInput("review", shown.draft, shown.base).input).toMatchObject({ required: 4 });
		expect(rebase(shown.draft, shown.base, shown.base, "checks").verify).toEqual(["npm test"]);
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
