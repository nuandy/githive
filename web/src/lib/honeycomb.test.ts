import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { agentColor, hexGrid, hexPoints, hiveAgents, honeycomb } from "./honeycomb";

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, agent: string, paths: string[], over: Partial<Claim> = {}): Claim => ({
	change,
	agent,
	paths,
	intent: `Work on ${change}`,
	since: "2026-10-09T00:00:00.000Z",
	active: "2026-10-09T00:00:00.000Z",
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
/** A minute after the claims were made: nobody's turn has run out. */
const now = Date.parse("2026-10-09T00:01:00.000Z");
const files = [
	"README.md",
	"package.json",
	"docs/guide.md",
	"docs/api.md",
	"src/index.ts",
	"src/stats/page.tsx",
	"src/stats/charts/bar.tsx",
	"src/auth/login.ts",
	"web/app.tsx",
];
const keys = (hexes: { key: string }[]) => hexes.map((h) => h.key);

describe("an agent's color", () => {
	it("is the same for the same name every time, and one of the claim colors", () => {
		expect(agentColor("agent-a")).toBe(agentColor("agent-a"));
		for (const name of ["agent-a", "agent-b", "", "a very long agent name/with a slash"]) {
			expect(agentColor(name)).toBeGreaterThanOrEqual(0);
			expect(agentColor(name)).toBeLessThan(8);
		}
		// Similar names spread over the palette.
		expect(new Set(Array.from({ length: 16 }, (_, i) => agentColor(`agent-${i}`))).size).toBeGreaterThan(4);
	});
});

describe("the honeycomb", () => {
	it("has a cell per top-level folder, then the top-level files, when nothing is claimed below the top", () => {
		const hexes = honeycomb(files, [claim("docs", "agent-a", ["docs/"])], { now });
		expect(keys(hexes)).toEqual(["docs", "src", "web", "*"]);
		expect(hexes.find((h) => h.key === "src")?.files).toBe(4);
		expect(hexes.find((h) => h.key === "*")).toMatchObject({ kind: "files", path: "", files: 2 });
		const docs = hexes.find((h) => h.key === "docs")!;
		expect(docs.holders).toEqual([
			expect.objectContaining({
				change: "docs",
				agent: "agent-a",
				whole: true,
				paths: ["docs/"],
				color: agentColor("agent-a"),
				lamp: "building",
			}),
		]);
		expect(hexes.find((h) => h.key === "src")!.holders).toEqual([]);
	});

	it("opens a folder claimed below its top into its second-level folders, with a cell for its own files", () => {
		const hexes = honeycomb(
			files,
			[claim("stats", "agent-a", ["src/stats/charts/"]), claim("entry", "agent-b", ["src/index.ts"])],
			{ now },
		);
		expect(keys(hexes)).toEqual(["docs", "src/*", "src/auth", "src/stats", "web", "*"]);
		const stats = hexes.find((h) => h.key === "src/stats")!;
		expect(stats).toMatchObject({ name: "stats", parent: "src", files: 2 });
		expect(stats.holders).toEqual([
			expect.objectContaining({ change: "stats", whole: false, paths: ["src/stats/charts/"] }),
		]);
		expect(hexes.find((h) => h.key === "src/*")!.holders).toEqual([
			expect.objectContaining({ change: "entry", whole: false }),
		]);
		expect(hexes.find((h) => h.key === "src/auth")!.holders).toEqual([]);
	});

	it("opens a big folder even when nothing is claimed in it", () => {
		expect(keys(honeycomb(files, [], { now, big: 3 }))).toEqual(["docs", "src/*", "src/auth", "src/stats", "web", "*"]);
	});

	it("puts the most specific whole claim first, a top-level file claim on the top-level files, and a whole-repo claim everywhere", () => {
		const hexes = honeycomb(
			files,
			[
				claim("all", "agent-z", [""]),
				claim("src", "agent-a", ["src/"]),
				claim("auth", "agent-b", ["src/auth/login.ts"]),
				claim("readme", "agent-c", ["README.md"]),
			],
			{ now },
		);
		expect(hexes.find((h) => h.key === "src/auth")!.holders.map((h) => [h.change, h.whole])).toEqual([
			["src", true],
			["all", true],
			["auth", false],
		]);
		expect(hexes.find((h) => h.key === "*")!.holders.map((h) => [h.change, h.whole])).toEqual([
			["all", true],
			["readme", false],
		]);
		expect(hexes.find((h) => h.key === "docs")!.holders.map((h) => h.change)).toEqual(["all"]);
	});

	it("adds cells for claimed folders that aren't on the branch yet", () => {
		const hexes = honeycomb(
			files,
			[claim("pkg", "agent-a", ["packages/cli/"]), claim("new", "agent-b", ["src/billing/"])],
			{ now },
		);
		expect(hexes.find((h) => h.key === "packages")).toMatchObject({
			planned: true,
			files: 0,
			holders: [expect.objectContaining({ change: "pkg", whole: false })],
		});
		expect(hexes.find((h) => h.key === "src/billing")).toMatchObject({
			planned: true,
			parent: "src",
			holders: [expect.objectContaining({ change: "new", whole: true })],
		});
	});

	it("marks a cell whose change is being checked to land, or approved and waiting", () => {
		const head = "a".repeat(40);
		const approved = { head, approval: { approved: true, approvals: 1, required: 1, vetoedBy: [] } };
		const landing = { checking: { base: "m", since: "", changes: [{ change: "docs", head, agent: "agent-a" }] } };
		const hexes = honeycomb(
			files,
			[
				claim("docs", "agent-a", ["docs/"], approved),
				claim("web", "agent-b", ["web/"], approved),
				claim("src", "agent-c", ["src/"]),
			],
			{ now, landing },
		);
		expect(hexes.find((h) => h.key === "docs")!.landing).toBe("checking");
		expect(hexes.find((h) => h.key === "web")!.landing).toBe("queued");
		expect(hexes.find((h) => h.key === "src")!.landing).toBeUndefined();
	});

	it("lists the agents holding claims with their changes", () => {
		const agents = hiveAgents(
			[claim("b1", "agent-b", ["web/"]), claim("a1", "agent-a", ["docs/"]), claim("b2", "agent-b", ["src/"])],
			{ now },
		);
		expect(agents.map((a) => [a.agent, a.color, a.changes.map((c) => c.change)])).toEqual([
			["agent-a", agentColor("agent-a"), ["a1"]],
			["agent-b", agentColor("agent-b"), ["b1", "b2"]],
		]);
	});
});

describe("the honeycomb's geometry", () => {
	it("lays cells in rows, every other row shifted half a cell", () => {
		const grid = hexGrid(5, 3, 10);
		const cellWidth = Math.sqrt(3) * 10;
		expect(grid.centers[0]).toEqual({ x: Math.round((cellWidth / 2) * 100) / 100, y: 10 });
		expect(grid.centers[3].y).toBe(25);
		expect(grid.centers[3].x).toBeCloseTo(cellWidth, 1);
		expect(grid.width).toBeCloseTo(3.5 * cellWidth, 1);
		expect(grid.height).toBe(35);
		// Fewer cells than columns: as wide as the cells.
		expect(hexGrid(2, 10, 10).width).toBeCloseTo(2 * cellWidth, 1);
	});

	it("draws a pointy-top hexagon", () => {
		expect(hexPoints(0, 0, 10).split(" ")[0]).toBe("0,-10");
		expect(hexPoints(0, 0, 10).split(" ")).toHaveLength(6);
	});
});
