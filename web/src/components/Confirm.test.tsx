import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Undo, UndoState } from "../hooks/useUndo";
import { visibleText } from "../test/fixtures";
import { ConfirmButton } from "./Confirm";
import { UndoLine } from "./ui/undo-line";

// A destructive action asks first, naming what it changes, and the way out says what it keeps. What can be taken back
// offers Undo for a while instead.

const asking = (keep?: string) =>
	visibleText(
		renderToStaticMarkup(
			<ConfirmButton
				id="invite"
				confirming="invite"
				setConfirming={() => undefined}
				label="Cancel invitation"
				question="Cancel dan@example.com's invitation? They won't join acme when they sign in."
				{...(keep ? { keep } : {})}
				busy={false}
				onConfirm={() => undefined}
			/>,
		),
	);

describe("a question before a destructive action", () => {
	it("says no by what it keeps, never Cancel beside Yes, cancel", () => {
		const text = asking("Keep invitation");
		expect(text).toContain("They won t join acme when they sign in.");
		expect(text).toContain("Yes, cancel invitation");
		expect(text).toContain("Keep invitation");
		expect(text).not.toMatch(/\bCancel\b(?! invitation| dan)/);
	});

	it("still says Cancel where it isn't told what it keeps", () => {
		expect(asking()).toMatch(/Yes, cancel invitation Cancel/);
	});
});

describe("the undo line", () => {
	const line = (state: UndoState, where = "members") =>
		renderToStaticMarkup(
			<UndoLine undo={{ state, offer: () => undefined, undo: async () => undefined } as Undo} where={where} />,
		);
	const offer = {
		id: 1,
		where: "members",
		done: "Cancelled dan@example.com's invitation.",
		undone: "dan@example.com is invited again.",
		undo: async () => undefined,
	};

	it("says what was done, with Undo, in a live region that's there before it speaks", () => {
		const html = line({ kind: "offered", ...offer });
		expect(html).toMatch(/^<div data-slot="undo-line" role="status"/);
		expect(visibleText(html)).toContain("Cancelled dan@example.com s invitation. Undo");
		expect(line({ kind: "idle" })).toBe('<div data-slot="undo-line" role="status"></div>');
		// Another section's line isn't this one's.
		expect(visibleText(line({ kind: "offered", ...offer }, "teams")).trim()).toBe("");
	});

	it("says what's so once undone, and why it couldn't be", () => {
		expect(visibleText(line({ kind: "undone", ...offer }))).toContain("dan@example.com is invited again.");
		expect(visibleText(line({ kind: "undone", ...offer }))).not.toContain("Undo");
		expect(visibleText(line({ kind: "offered", ...offer, error: "no org acme" }))).toContain(
			"Couldn t undo: no org acme. Try again.",
		);
	});
});
