import { describe, expect, it } from "vitest";
import { ago, NOW } from "../test/fixtures";
import type { Goal } from "./goals";
import { agentChip, agentHue, cellNames, fitLines, hiveCells, middleCut, sansWidth } from "./hiveCells";

const FILES = [
	"package.json",
	"Readme.md",
	"lib/express.js",
	"lib/router/index.js",
	"lib/router/layer.js",
	"test/res.links.js",
	"test/res.type.js",
	"test/req.is.js",
	"test/support/utils.js",
	"examples/hello/index.js",
];

const goal = (change: string, paths: string[], extra: Partial<Goal> = {}): Goal => ({
	key: change,
	change,
	agent: "agent-19",
	title: change,
	intent: change,
	paths,
	state: "building",
	announced: ago(10),
	steps: [],
	earlierSteps: false,
	...extra,
});

const cellsOf = (result: ReturnType<typeof hiveCells>) => result.clusters.flatMap((cluster) => cluster.cells);

describe("the hive map's cells", () => {
	it("opens a busy folder down to the files agents work on, folding the rest of it, and keeps quiet folders whole", () => {
		const result = hiveCells(FILES, [goal("links", ["test/res.links.js"])], [], NOW);
		expect(result.clusters.map((cluster) => [cluster.key, cluster.label])).toEqual([
			["test", "test/ · 1 agent at work"],
			["", "the rest of the repo"],
		]);
		const test = result.clusters[0]!.cells;
		expect(test.map((cell) => cell.key)).toEqual(["test/res.links.js", "test/*"]);
		expect(test[0]).toMatchObject({ state: "building", agents: ["agent-19"], goals: ["links"] });
		// test/support and the two other test files, in one cell.
		expect(test[1]).toMatchObject({ name: "the others", files: 3, folders: 1, state: "free" });
		expect(result.clusters[1]!.cells.map((cell) => cell.key)).toEqual(["examples", "lib", "*"]);
	});

	it("lights a claimed folder whole, and a cell shared by goals takes the loudest state", () => {
		const goals = [
			goal("router", ["lib/router/"], { state: "in-review" }),
			goal("layer", ["lib/router/layer.js"], { state: "changes-requested", agent: "agent-5" }),
		];
		const cells = cellsOf(hiveCells(FILES, goals, [], NOW));
		const layer = cells.find((cell) => cell.key === "lib/router/layer.js");
		expect(layer?.state).toBe("changes-requested");
		expect(layer?.goals).toEqual(["layer", "router"]);
	});

	it("draws a file a change is creating as a planned cell", () => {
		const cells = cellsOf(hiveCells(FILES, [goal("new", ["test/res.links.edges.js"])], [], NOW));
		expect(cells.find((cell) => cell.key === "test/res.links.edges.js")).toMatchObject({
			planned: true,
			state: "building",
		});
	});

	it("keeps who landed what lately, and shows backlog work waiting as up next", () => {
		const landed = goal("type", ["test/res.type.js"], { state: "landed", finished: ago(5), agent: "agent-16" });
		const next = { id: "is", title: "is", intent: "is", paths: ["test/req.is.js"], by: "planner", at: ago(30) };
		const cells = cellsOf(hiveCells(FILES, [landed], [next], NOW));
		expect(cells.find((cell) => cell.key === "test/res.type.js")).toMatchObject({
			state: "landed",
			landed: { agent: "agent-16" },
		});
		expect(cells.find((cell) => cell.key === "test/req.is.js")?.state).toBe("next");
	});

	it("lets landed work go dark after a while", () => {
		const old = goal("type", ["test/res.type.js"], { state: "landed", finished: ago(45) });
		const result = hiveCells(FILES, [old], [], NOW);
		expect(result.clusters.map((cluster) => cluster.key)).toEqual([""]);
		expect(result.clusters[0]!.label).toBe("the repo");
	});
});

describe("an agent's chip", () => {
	it("is its number, or its initials", () => {
		expect(agentChip("agent-19")).toBe("19");
		expect(agentChip("githive-forager")).toBe("Fo");
		expect(agentChip("alice-claude")).toBe("AC");
	});
});

describe("a name in a cell", () => {
	it("is cut in the middle, so its end and extension stay", () => {
		expect(middleCut("OrderSummary.tsx", 12)).toBe("Ord…mary.tsx");
		expect(middleCut("index.js", 12)).toBe("index.js");
		expect(middleCut("content-negotiation", 12)).toBe("con…otiation");
		expect(middleCut("abcdefghijklmn", 12)).toHaveLength(12);
	});

	it("keeps a short first word whole where the name has one", () => {
		expect(middleCut("res.sendFile.js", 12)).toBe("res.…File.js");
		expect(middleCut("res.download.js", 12)).toBe("res.…load.js");
	});
});

describe("names side by side", () => {
	it("are cut in the middle, unless that leaves two alike: then at the end, where they differ", () => {
		const swarm = ["res.send.edges.js", "res.sendStatus.edges.js", "req.protocol.edges.js", "index.js"];
		expect(cellNames(swarm, 12)).toEqual(["res.send.ed…", "res.sendSta…", "req.protoco…", "index.js"]);
		const mixed = ["res.download.js", "res.sendFile.js", "res.send.js"];
		expect(cellNames(mixed, 12)).toEqual(["res.…load.js", "res.…File.js", "res.send.js"]);
	});
});

describe("a cell's state words", () => {
	// Ten letters to a line, a space as one: room enough to test the splitting.
	const width = (text: string) => text.length;

	it("stay on one line when they fit", () => {
		expect(fitLines("building", [10, 8], width)).toEqual(["building"]);
	});

	it("break where both lines fit, as evenly as they can", () => {
		expect(fitLines("changes requested", [10, 9], width)).toEqual(["changes", "requested"]);
		expect(fitLines("needs a person", [10, 8], width)).toEqual(["needs a", "person"]);
	});

	it("are cut short rather than overflow", () => {
		const lines = fitLines("abandoned, free to take", [10, 8], width);
		expect(lines).toHaveLength(2);
		lines.forEach((line, index) => expect(line.length).toBeLessThanOrEqual([10, 8][index]!));
		expect(lines[1]!.endsWith("…")).toBe(true);
		expect(fitLines("unbreakableword", [10, 8], width)).toEqual(["unbreakab…"]);
	});

	it("are measured in the map's face, generously", () => {
		// "needs a person" is about 70px at 10px.
		expect(sansWidth("needs a person", 10)).toBeGreaterThan(66);
		expect(sansWidth("needs a person", 10)).toBeLessThan(76);
		expect(sansWidth("WW", 10)).toBeGreaterThan(sansWidth("ii", 10) * 2);
	});
});

describe("an agent's hue", () => {
	it("is one of the theme's hues that no lamp means anything by, and the same every time", () => {
		const hues = ["agent-1", "agent-2", "alice-claude", "bob-codex", "githive-forager"].map(agentHue);
		// claim-1 is amber, claim-5 green and claim-6 red: the lamps' colors.
		for (const hue of hues) expect([0, 2, 3, 4, 7]).toContain(hue);
		expect(agentHue("alice-claude")).toBe(hues[2]);
		// Not all the same.
		expect(new Set(hues).size).toBeGreaterThan(2);
	});
});
