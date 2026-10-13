import { describe, expect, it } from "vitest";
import { type UndoState, undoStep, UNDO_MS } from "./useUndo";

// After an action that can be taken back (cancelling an invitation, removing a collaborator), a line says what was done
// and offers Undo for a while; Undo makes the opposite call.

const idle: UndoState = { kind: "idle" };
const undo = async () => undefined;
const offered = undoStep(idle, {
	type: "offer",
	id: 1,
	where: "members",
	done: "Cancelled dan's invitation.",
	undone: "dan is invited again.",
	undo,
});

describe("an undo line", () => {
	it("offers Undo for about ten seconds", () => {
		expect(UNDO_MS).toBe(10_000);
		expect(offered).toMatchObject({ kind: "offered", id: 1, where: "members", done: "Cancelled dan's invitation." });
		expect(undoStep(offered, { type: "expire", id: 1 })).toEqual(idle);
	});

	it("takes the newest action's place, and an older one's time running out leaves it be", () => {
		const newer = undoStep(offered, {
			type: "offer",
			id: 2,
			where: "teams",
			done: "Took sol off @acme/web.",
			undone: "sol is back on @acme/web.",
			undo,
		});
		expect(newer).toMatchObject({ kind: "offered", id: 2, where: "teams" });
		expect(undoStep(newer, { type: "expire", id: 1 })).toBe(newer);
	});

	it("says it's undoing, then that it's undone, and goes in time", () => {
		const undoing = undoStep(offered, { type: "start", id: 1 });
		expect(undoing).toMatchObject({ kind: "undoing", id: 1 });
		// Its time doesn't run out while the call is under way.
		expect(undoStep(undoing, { type: "expire", id: 1 })).toBe(undoing);
		const undone = undoStep(undoing, { type: "undone", id: 1 });
		expect(undone).toMatchObject({ kind: "undone", id: 1, where: "members" });
		expect(undoStep(undone, { type: "expire", id: 1 })).toEqual(idle);
	});

	it("says why undoing failed, and offers it again", () => {
		const failed = undoStep(undoStep(offered, { type: "start", id: 1 }), {
			type: "failed",
			id: 1,
			error: "no org acme",
		});
		expect(failed).toMatchObject({ kind: "offered", id: 1, error: "no org acme" });
		expect(undoStep(failed, { type: "start", id: 1 })).toMatchObject({ kind: "undoing", error: undefined });
	});

	it("ignores what's said about a line that's gone", () => {
		expect(undoStep(idle, { type: "start", id: 1 })).toBe(idle);
		expect(undoStep(offered, { type: "undone", id: 7 })).toBe(offered);
	});
});
