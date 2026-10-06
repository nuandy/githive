import { describe, expect, it } from "vitest";
import { ago, freeSnapshot, makeChange, makeTask } from "../test/fixtures";
import { claimedElsewhere, covers, holderOf, holdersFromSnapshot, holdersFromTask, holdsInside } from "./claimsMap";

const task = makeTask({
	slices: [
		makeChange({ id: "stats", title: "Stats page", owns: ["src/stats/"], touched: ["src/stats/page.tsx", "src/stats/new.ts"], openedBy: "agent:agent-a" }),
		makeChange({ id: "readme", title: "README", owns: ["README.md"], openedBy: "agent:agent-b" }),
		makeChange({ id: "deep", title: "Deeper claim", owns: ["src/stats/charts/"] }),
		makeChange({ id: "done", status: "integrated", owns: ["docs/"] }),
	],
	checks: [{ pair: ["readme", "stats"], heads: ["a", "b"], status: "conflict", files: ["README.md"], checkedAt: ago(1) }],
});
const files = ["README.md", "docs/guide.md", "src/index.ts", "src/stats/page.tsx", "src/stats/charts/bar.tsx"];

describe("the claims map", () => {
	const holders = holdersFromTask(task, "my-app");

	it("takes each open change's claimed and changed paths, a color, and its conflicts", () => {
		expect(holders.map((h) => [h.change, h.agent, h.color, h.paths, h.conflicts, h.href])).toEqual([
			["stats", "agent-a", 0, ["src/stats/", "src/stats/page.tsx", "src/stats/new.ts"], ["README.md"], "#/repos/my-app/changes/stats"],
			["readme", "agent-b", 1, ["README.md"], ["README.md"], "#/repos/my-app/changes/readme"],
			["deep", "Blueprint builder", 2, ["src/stats/charts/"], [], "#/repos/my-app/changes/deep"],
		]);
	});

	it("colors a claimed folder's whole subtree, the most specific claim winning", () => {
		expect(covers("src/stats/", "src/stats/page.tsx")).toBe(true);
		expect(covers("src/stats", "src/stats")).toBe(true);
		expect(covers("src/stats/", "src/statsx/a.ts")).toBe(false);
		expect(holderOf("src/stats/page.tsx", holders)?.change).toBe("stats");
		expect(holderOf("src/stats/charts/bar.tsx", holders)?.change).toBe("deep");
		expect(holderOf("src/stats", holders)?.change).toBe("stats");
		expect(holderOf("src/index.ts", holders)).toBeUndefined();
		expect(holderOf("docs/guide.md", holders)).toBeUndefined();
	});

	it("opens folders that hold claims, and lists claims not on the branch yet", () => {
		expect(holdsInside("src", holders)).toBe(true);
		expect(holdsInside("docs", holders)).toBe(false);
		expect(claimedElsewhere(files, holders).map((x) => [x.path, x.holder.change])).toEqual([["src/stats/new.ts", "stats"]]);
	});

	it("reads a coordinator-free repo's claims from its snapshot", () => {
		expect(holdersFromSnapshot(freeSnapshot, "docs-site")).toEqual([
			{ change: "c-1", title: "Rewrite the C section", agent: "agent-c", paths: ["src/c/"], href: "#/free/docs-site/changes/c-1", color: 0, conflicts: [] },
		]);
	});
});
