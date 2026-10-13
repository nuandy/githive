import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Goal } from "../lib/goals";
import { hiveCells } from "../lib/hiveCells";
import { ago, NOW, visibleText } from "../test/fixtures";
import { HiveMap, pickCell } from "./HiveMap";

const FILES = [
	"README.md",
	"lib/express.js",
	"test/res.links.js",
	"test/res.type.js",
	"test/req.is.js",
	"examples/a/index.js",
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

const GOALS = [
	goal("links", ["test/res.links.js"]),
	goal("type", ["test/res.type.js"], { state: "landing", agent: "agent-16" }),
	goal("is", ["test/req.is.js"], { state: "landed", finished: ago(4), agent: "agent-7" }),
];

const render = (props: Partial<Parameters<typeof HiveMap>[0]> = {}) =>
	renderToStaticMarkup(
		<HiveMap
			repo="acme/web"
			branch="main"
			cells={hiveCells(FILES, GOALS, [], NOW)}
			lit={new Set()}
			filter={null}
			motions={new Map()}
			onHover={() => undefined}
			onPick={() => undefined}
			now={NOW}
			{...props}
		/>,
	);

describe("the hive map", () => {
	it("opens the busy folder up, and draws a labelled cell in each one's stage, the map one stop for Tab", () => {
		const html = render();
		expect(visibleText(html)).toContain("test/ · 2 agents at work");
		// Each cell is named by its name in full and its state, as its words show them, then where it is.
		expect(html).toMatch(
			/data-state="building"[^>]*role="button" tabindex="-1" aria-label="res.links.js: building, agent-19 at work, in test\/"/,
		);
		// The arrow keys go from cell to cell; Tab reaches the first.
		expect(html.match(/tabindex="0"/g)).toHaveLength(1);
		expect(html).toMatch(/tabindex="0" aria-label="req.is.js/);
		expect(html).toMatch(/data-state="landing"[^>]*aria-label="res.type.js: landing, agent-16 at work, in test\/"/);
		// Its blinking lamp.
		expect(html).toMatch(/<circle class="[^"]*animate-hive-cell-blink[^"]*"/);
		expect(html).toMatch(/data-state="landed"[^>]*aria-label="req.is.js: landed lately by agent-7, in test\/"/);
		expect(html).toMatch(/aria-label="lib\/: 1 file"/);
		expect(html).toMatch(/aria-label="top files: 1 file"/);
		const others = hiveCells(["lib/a.js", "lib/b.js", "lib/x/c.js", "lib/y/d.js"], [goal("a", ["lib/a.js"])], [], NOW);
		expect(render({ cells: others })).toMatch(/aria-label="the others: 3 files, in lib\/"/);
		// The agents' chips: their numbers, in a ring of the agent's own hue.
		expect(html).toMatch(
			/<circle class="[^"]*stroke-hue-\d[^"]*" cx="0" cy="-22" r="10"><\/circle><text[^>]*>19<\/text>/,
		);
	});

	it("says a cell's state in the same words it's named by, and keys the red ones", () => {
		const goals = [goal("links", ["test/res.links.js"], { state: "changes-requested" })];
		const html = render({ cells: hiveCells(FILES, goals, [], NOW) });
		expect(html).toMatch(/aria-label="res.links.js: changes requested, agent-19 at work, in test\/"/);
		// Too long for a cell's width, its words take two lines, and still read as written.
		expect(html).toMatch(/<tspan[^>]*>changes <\/tspan><tspan[^>]*>requested<\/tspan>/);
		expect(visibleText(html)).toContain("! needs a person × changes requested × checks failed");
	});

	it("writes nothing smaller than 10px, and only a cell's own name, cut in the middle", () => {
		const deep = ["packages/auth/src/OrderSummary.tsx", "packages/auth/src/index.ts"];
		const goals = [goal("summary", [deep[0]!])];
		const html = render({ cells: hiveCells(deep, goals, [], NOW) });
		const sizes = [...html.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((match) => Number(match[1]));
		expect(sizes.length).toBeGreaterThan(0);
		for (const size of sizes) expect(size).toBeGreaterThanOrEqual(10);
		expect(html).toMatch(/>Ord…mary.tsx<\/text>/);
		// Its folder is in the tooltip and the details, not on the cell.
		expect(html).not.toContain("auth/src/</text>");
		expect(html).toContain('aria-label="OrderSummary.tsx: building, agent-19 at work, in packages/auth/src/"');
		// The words a cell shows, cut to fit, and its chips' letters are drawn over it, out of its button: its name
		// says them in full (WCAG 2.5.3).
		const buttons = [...html.matchAll(/<g [^>]*role="button"[^>]*>(.*?)<\/g>/g)].map((match) => match[1]);
		expect(buttons.length).toBeGreaterThan(0);
		for (const inside of buttons) expect(inside).not.toContain("<text");
		expect(html).toMatch(/<g class="pointer-events-none" aria-hidden="true"><text[^>]*>Ord…mary.tsx<\/text>/);
	});

	it("keeps a state's words inside the cell, on two lines where one won't do", () => {
		const goals = [goal("links", ["test/res.links.js"], { state: "needs-person" })];
		const html = render({ cells: hiveCells(FILES, goals, [], NOW) });
		expect(html).toMatch(/<tspan[^>]*>needs a <\/tspan><tspan[^>]*>person<\/tspan>/);
		// Words that need a person are in ink on the red fill; amber's in --warn, never amber on its tint.
		expect(html).toMatch(/fill-foreground font-bold[^>]*><tspan/);
	});

	it("dims what an agent filter leaves out", () => {
		const html = render({ filter: { kind: "agent", agent: "agent-16" } });
		// The cell dims whole, its words and chips with it.
		expect(html).toMatch(
			/<g class="[^"]*\bopacity-30\b[^"]*"[^>]*><g[^>]*><g data-state="building"[^>]*aria-label="res.links.js/,
		);
		expect(html).not.toMatch(/<g class="[^"]*\bopacity-30\b[^"]*"[^>]*><g[^>]*><g data-state="landing"/);
	});

	it("says while the tree loads, when it can't be read, and when the branch is empty", () => {
		expect(render({ cells: undefined })).toContain("Reading the tree…");
		expect(render({ cells: undefined, error: "no commits" })).toContain("The tree couldn&#x27;t be read: no commits");
		expect(render({ cells: { clusters: [], more: 0 } })).toContain("main has no files yet.");
	});
});

describe("picking a cell", () => {
	// Each step: the details open and the cell the goals are filtered to, then a click, a tap or Enter on a cell.
	const play = (steps: string[]) => {
		let opened: string | null = null;
		let picked: string | undefined;
		const seen: string[] = [];
		for (const key of steps) {
			const next = pickCell(opened, picked, key);
			opened = next.opened;
			if (next.filter) picked = picked === key ? undefined : key;
			seen.push(`${opened ?? "-"}/${picked ?? "-"}`);
		}
		return seen;
	};

	it("opens a cell's details and filters to it, and a second pick closes both", () => {
		expect(play(["a", "a"])).toEqual(["a/a", "-/-"]);
	});

	it("moves the details and the filter together from one cell to another", () => {
		expect(play(["a", "b", "b"])).toEqual(["a/a", "b/b", "-/-"]);
	});

	it("opens the details again, keeping the filter, once they were closed another way (Escape)", () => {
		// Escape closes the details and leaves the filter: details null, filter on the cell.
		expect(pickCell(null, "b", "b")).toEqual({ opened: "b", filter: false });
	});

	it("closes the details without touching the filter once it was cleared elsewhere", () => {
		expect(pickCell("a", undefined, "a")).toEqual({ opened: null, filter: false });
	});
});
