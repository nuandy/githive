import { describe, expect, it } from "vitest";
import { concernsOf } from "../src/toolkit/ring-concerns";
import type { ToolContext } from "../src/toolkit/tools/context";

// Whom each tool's write concerns, so the doorbell wakes only them: work taken away concerns no agent waiting, work
// that may be offered concerns anyone with room, a vote its change's agent and its voter.

const ctx = {
	agent: "rev",
	keptClaims: async () => ({ claims: [{ change: "c-1", agent: "author" }], merged: [] }),
} as unknown as ToolContext;

describe("whom a write concerns", () => {
	it("names no agent for work taken away, and opens for work that may be offered", async () => {
		expect(await concernsOf("claim", { repo: "p" }, ctx)).toEqual({ for: [] });
		expect(await concernsOf("merge", { repo: "p" }, ctx)).toEqual({ for: [] });
		expect(await concernsOf("release", { repo: "p" }, ctx)).toEqual({ opens: true });
		expect(await concernsOf("add_work", { repo: "p" }, ctx)).toEqual({ opens: true });
	});

	it("names a vote's change agent and its voter, and the agent giving a review back", async () => {
		expect(await concernsOf("vote", { repo: "p", change: "c-1" }, ctx)).toEqual({ for: ["author", "rev"] });
		expect(await concernsOf("vote", { repo: "p", change: "c-1", reviewer: "bee" }, ctx)).toEqual({
			for: ["author", "bee"],
		});
		expect(await concernsOf("leave_review", { repo: "p", agent: "bee" }, ctx)).toEqual({ for: ["bee"], opens: true });
	});

	it("says nothing it can't place, which wakes everyone", async () => {
		expect(await concernsOf("vote", { repo: "p", commit: "abc" }, ctx)).toBeUndefined();
		expect(await concernsOf("vote", { repo: "p", change: "unknown" }, ctx)).toBeUndefined();
		expect(await concernsOf("settings_of_some_kind", { repo: "p" }, ctx)).toBeUndefined();
	});
});
