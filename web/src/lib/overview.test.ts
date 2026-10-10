import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { cellLamp, lampCounts, lampOf, territory } from "./overview";

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, paths: string[], over: Partial<Claim> = {}): Claim => ({
	change,
	agent: `agent-${change}`,
	paths,
	intent: change,
	since: "2026-10-09T00:00:00.000Z",
	active: "2026-10-09T00:00:00.000Z",
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const pushed = { head: "a".repeat(40) };
/** A minute after the claims were made: nobody's turn has run out. */
const soon = Date.parse("2026-10-09T00:01:00.000Z");
const approved = { ...pushed, approval: { approved: true, approvals: 1, required: 1, vetoedBy: [] } };

describe("a claim's lamp", () => {
	it("says where its change is, a person's question or veto first", () => {
		expect(lampOf(claim("a", ["x/"]), { now: soon })).toBe("building");
		expect(lampOf(claim("a", ["x/"], pushed), { now: soon })).toBe("review");
		expect(lampOf(claim("a", ["x/"], approved), { now: soon })).toBe("approved");
		const landing = { checking: { base: "m", since: "", changes: [{ change: "a", head: approved.head, agent: "a" }] } };
		expect(lampOf(claim("a", ["x/"], approved), { landing, now: soon })).toBe("checking");
		// Only its head as it's being checked: a newer push waits for review again.
		expect(lampOf(claim("a", ["x/"], { ...pushed, head: "b".repeat(40) }), { landing, now: soon })).toBe("review");
		expect(
			lampOf(claim("a", ["x/"], { ...approved, attention: { reason: "?", agent: "a", at: "" } }), {
				landing,
				now: soon,
			}),
		).toBe("attention");
		expect(
			lampOf(
				claim("a", ["x/"], {
					...pushed,
					approval: { approved: false, approvals: 0, required: 1, vetoedBy: ["security"] },
				}),
				{ now: soon },
			),
		).toBe("attention");
	});

	it("shows a change abandoned on its agent's turn, as the toolkit frees it, and never one waiting for review", () => {
		const hours = (n: number) => Date.parse("2026-10-09T00:00:00.000Z") + n * 3_600_000;
		expect(lampOf(claim("a", ["x/"]), { now: hours(1) })).toBe("abandoned");
		expect(lampOf(claim("a", ["x/"], pushed), { now: hours(24) })).toBe("review");
		const votes = [
			{
				commit: pushed.head,
				reviewer: "r",
				role: "review",
				verdict: "approve" as const,
				evidence: "",
				at: "2026-10-09T00:00:00.000Z",
			},
		];
		expect(lampOf(claim("a", ["x/"], approved), { votes, now: hours(1) })).toBe("approved");
		expect(lampOf(claim("a", ["x/"], approved), { votes, now: hours(3) })).toBe("abandoned");
		// Its checks failed, which rejects its head: handed back to its agent, then abandoned.
		const failed = [
			{
				commit: pushed.head,
				reviewer: "githive-checks",
				role: "checks",
				verdict: "reject" as const,
				evidence: "",
				at: "2026-10-09T00:00:00.000Z",
			},
		];
		expect(lampOf(claim("a", ["x/"], pushed), { votes: failed, now: hours(3) })).toBe("abandoned");
	});

	it("is counted per lamp", () => {
		const counts = lampCounts([claim("a", ["x/"]), claim("b", ["y/"], pushed), claim("c", ["z/"], pushed)], {
			now: soon,
		});
		expect(counts).toMatchObject({ building: 1, review: 2, approved: 0 });
	});
});

describe("the territory", () => {
	const files = ["lib/a.js", "lib/router/index.js", "test/t.js", "README.md"];

	it("has a region per top-level folder, the top-level files last, each split one level in", () => {
		const regions = territory(files, []);
		expect(regions.map((r) => r.name)).toEqual(["lib", "test", ""]);
		expect(regions[0]!.cells.map((c) => [c.name, !!c.folder])).toEqual([
			["a.js", false],
			["router", true],
		]);
		expect(regions[0]!.files).toBe(2);
	});

	it("lights the cell a claim covers, the whole region for a claim on the folder, and new paths as planned", () => {
		const regions = territory(
			files,
			[claim("r", ["lib/router/route.js"], pushed), claim("t", ["test/"], approved), claim("n", ["swarm/p1/"])],
			{ now: soon },
		);
		const lib = regions.find((r) => r.name === "lib")!;
		expect(
			cellLamp(
				lib.cells.find((c) => c.name === "router")!,
				lib,
			),
		).toBe("review");
		expect(
			cellLamp(
				lib.cells.find((c) => c.name === "a.js")!,
				lib,
			),
		).toBeUndefined();
		const test = regions.find((r) => r.name === "test")!;
		expect(test.whole.map((h) => h.change)).toEqual(["t"]);
		expect(cellLamp(test.cells[0]!, test)).toBe("approved");
		const swarm = regions.find((r) => r.name === "swarm")!;
		expect(swarm.files).toBe(0);
		expect(swarm.cells).toMatchObject([{ name: "p1", planned: true, folder: true }]);
	});

	it("shows a cell held by several changes at its most urgent", () => {
		const [lib] = territory(
			files,
			[
				claim("a", ["lib/router/x.js"], approved),
				claim("b", ["lib/router/y.js"], { ...pushed, attention: { reason: "?", agent: "b", at: "" } }),
			],
			{ now: soon },
		);
		const router = lib!.cells.find((c) => c.name === "router")!;
		expect(router.holders.map((h) => h.change)).toEqual(["b", "a"]);
	});
});
