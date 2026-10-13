import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { ago, repoSnapshot } from "../test/fixtures";
import {
	claimedElsewhere,
	claimedFiles,
	claimsOnOtherBranches,
	covers,
	heldIn,
	holderOf,
	holdersFromSnapshot,
	holdsInside,
	stateCounts,
} from "./claimsMap";

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, agent: string, paths: string[], over: Partial<Claim> = {}): Claim => ({
	change,
	agent,
	paths,
	intent: change,
	since: ago(30),
	active: ago(5),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const snapshot = (claims: Claim[]) => ({ claims, votes: [], policy: { required: 1, vetoes: [] } });
const files = ["README.md", "docs/guide.md", "src/index.ts", "src/stats/page.tsx", "src/stats/charts/bar.tsx"];

describe("the claims map", () => {
	const holders = holdersFromSnapshot(
		snapshot([
			claim("stats", "agent-a", ["src/stats/", "src/stats/new.ts"]),
			claim("readme", "agent-b", ["README.md"]),
			claim("deep", "agent-c", ["src/stats/charts/"]),
		]),
		"acme/my-app",
	);

	it("reads a repo's claims from its snapshot, each in its change's state, with a link to its change", () => {
		expect(holdersFromSnapshot(repoSnapshot, "acme/docs-site")).toEqual([
			{
				change: "c-1",
				title: "Rewrite the C section",
				agent: "agent-c",
				paths: ["src/c/"],
				href: "#/repos/acme/docs-site/changes/c-1",
				state: "changes-requested",
				conflicts: [],
			},
		]);
		expect(holders.map((h) => [h.change, h.state, h.href])).toEqual([
			["stats", "building", "#/repos/acme/my-app/changes/stats"],
			["readme", "building", "#/repos/acme/my-app/changes/readme"],
			["deep", "building", "#/repos/acme/my-app/changes/deep"],
		]);
		// The batch being checked lights its changes as landing.
		const approved = { approved: true, approvals: 1, required: 1, vetoedBy: [] };
		const checked = holdersFromSnapshot(
			snapshot([claim("ready", "agent-a", ["a.ts"], { head: "h1", approval: approved })]),
			"acme/my-app",
			{ landing: { checking: { base: "b", since: "", changes: [{ change: "ready", head: "h1", agent: "" }] } } },
		);
		expect(checked[0]?.state).toBe("landing");
	});

	it("maps only the claims landing on the branch shown, and counts the others by branch", () => {
		const claims = snapshot([
			claim("main-1", "agent-a", ["src/a.ts"]),
			claim("backport", "agent-b", ["src/a.ts"], { into: "release/2.4" }),
			claim("backport-2", "agent-b", ["src/b.ts"], { into: "release/2.4" }),
		]);
		const onMain = holdersFromSnapshot({ ...claims, branch: "main" }, "acme/x", { branch: "main" });
		expect(onMain.map((h) => h.change)).toEqual(["main-1"]);
		expect(holderOf("src/a.ts", onMain)?.change).toBe("main-1");
		expect(claimsOnOtherBranches({ ...claims, branch: "main" }, "main")).toEqual([{ branch: "release/2.4", count: 2 }]);
	});

	it("lists only what's claimed, counts what each folder holds, and keys the states in their order", () => {
		expect(claimedFiles(files, holders)).toEqual(["README.md", "src/stats/page.tsx", "src/stats/charts/bar.tsx"]);
		expect(heldIn("src", files, holders)).toBe(2);
		expect(heldIn("docs", files, holders)).toBe(0);
		const mixed = [
			{ ...holders[0]!, state: "in-review" as const },
			{ ...holders[1]!, state: "needs-person" as const },
			{ ...holders[2]!, state: "in-review" as const },
		];
		expect(stateCounts(mixed)).toEqual([
			["needs-person", 1],
			["in-review", 2],
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
		expect(claimedElsewhere(files, holders).map((x) => [x.path, x.holder.change])).toEqual([
			["src/stats/new.ts", "stats"],
		]);
	});
});
