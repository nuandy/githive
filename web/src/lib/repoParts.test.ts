import { describe, expect, it } from "vitest";
import { touchedBy } from "./repoParts";

// A message from a repo's live feed reads again only the parts of its page that its kind of change touches.

describe("what a kind of change touches", () => {
	it("reads only what it touches, and everything for a kind it doesn't know", () => {
		expect([...touchedBy(["view:snapshot"])]).toEqual(["snapshot"]);
		expect([...touchedBy(["view:change:c-1", "view:history:main"])]).toEqual(["change"]);
		expect([...touchedBy(["awareness"])]).toEqual([]);
		expect([...touchedBy(["pushed"])]).toEqual(["snapshot", "change"]);
		expect([...touchedBy(["missed"])].sort()).toEqual(["audit", "change", "snapshot"]);
		expect([...touchedBy(["something-new"])].sort()).toEqual(["audit", "change", "snapshot"]);
	});
});
