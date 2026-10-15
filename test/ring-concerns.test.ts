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

describe("whom a release concerns", () => {
	/** A context whose backlog holds `items`. */
	const withBacklog = (items: object[]) =>
		({
			...ctx,
			records: () => ({ read: async () => ({ commit: { state: { items } } }) }),
		}) as unknown as ToolContext;
	const release = (context: ToolContext, reply: object, change = "c-1") =>
		concernsOf("release", { repo: "p", change }, context, { ok: true, ...reply });

	it("wakes no one when it can't free a backlog piece", async () => {
		expect(await release(withBacklog([]), { freed: ["src/a.ts"] })).toEqual({ for: [] });
		const elsewhere = withBacklog([{ id: "docs", title: "Docs", intent: "", paths: ["docs/"] }]);
		expect(await release(elsewhere, { freed: ["src/a.ts"] })).toEqual({ for: [] });
	});

	it("opens for the piece it was, a piece its paths held back, and once merged, a piece that waited on it", async () => {
		const backlog = withBacklog([
			{ id: "c-1", title: "One", intent: "" },
			{ id: "styles", title: "Styles", intent: "", paths: ["src/styles/"] },
			{ id: "wire", title: "Wire", intent: "", after: ["c-9"] },
		]);
		expect(await release(backlog, { freed: ["src/x.ts"] }, "c-1")).toEqual({ opens: true });
		expect(await release(backlog, { freed: ["src/styles/board.css"] }, "c-2")).toEqual({ opens: true });
		expect(await release(backlog, { freed: ["src/x.ts"] }, "c-9")).toEqual({ for: [] });
		expect(await release(backlog, { freed: ["src/x.ts"], merged: true }, "c-9")).toEqual({ opens: true });
	});

	it("opens as before when it says nothing of what it freed", async () => {
		expect(await release(withBacklog([]), {})).toEqual({ opens: true });
	});
});
