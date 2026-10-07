import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { ago, repoSnapshot } from "../test/fixtures";
import { claimedElsewhere, covers, holderOf, holdersFromSnapshot, holdsInside } from "./claimsMap";

const claim = (change: string, agent: string, paths: string[]): RepoSnapshot["claims"][number] => ({
	change,
	agent,
	paths,
	intent: change,
	since: ago(30),
	active: ago(5),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
});
const files = ["README.md", "docs/guide.md", "src/index.ts", "src/stats/page.tsx", "src/stats/charts/bar.tsx"];

describe("the claims map", () => {
	const holders = holdersFromSnapshot({ claims: [claim("stats", "agent-a", ["src/stats/", "src/stats/new.ts"]), claim("readme", "agent-b", ["README.md"]), claim("deep", "agent-c", ["src/stats/charts/"])] }, "my-app");

	it("reads a repo's claims from its snapshot, each with a color and a link to its change", () => {
		expect(holdersFromSnapshot(repoSnapshot, "docs-site")).toEqual([
			{ change: "c-1", title: "Rewrite the C section", agent: "agent-c", paths: ["src/c/"], href: "#/repos/docs-site/changes/c-1", color: 0, conflicts: [] },
		]);
		expect(holders.map((h) => [h.change, h.color, h.href])).toEqual([
			["stats", 0, "#/repos/my-app/changes/stats"],
			["readme", 1, "#/repos/my-app/changes/readme"],
			["deep", 2, "#/repos/my-app/changes/deep"],
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
});
