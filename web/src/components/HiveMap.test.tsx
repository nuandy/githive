import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Goal } from "../lib/goals";
import { hiveCells } from "../lib/hiveCells";
import { ago, NOW, visibleText } from "../test/fixtures";
import { HiveMap } from "./HiveMap";

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
		expect(html).toMatch(
			/data-state="building"[^>]*role="button" tabindex="-1" aria-label="test\/res.links.js: building, agent-19 at work"/,
		);
		// The arrow keys go from cell to cell; Tab reaches the first.
		expect(html.match(/tabindex="0"/g)).toHaveLength(1);
		expect(html).toMatch(/tabindex="0" aria-label="test\/req.is.js/);
		expect(html).toMatch(/data-state="landing"[^>]*aria-label="test\/res.type.js: landing, agent-16 at work"/);
		// Its blinking lamp.
		expect(html).toMatch(/<circle class="[^"]*animate-hive-cell-blink[^"]*"/);
		expect(html).toMatch(/data-state="landed"[^>]*aria-label="test\/req.is.js: agent-7 landed a change here lately"/);
		// The agents' chips: their numbers, in a ring of the agent's own hue.
		expect(html).toMatch(
			/<circle class="[^"]*stroke-hue-\d[^"]*" cx="0" cy="-22" r="10"><\/circle><text[^>]*>19<\/text>/,
		);
	});

	it("says a cell's state in the same words it's named by, and keys the red ones", () => {
		const goals = [goal("links", ["test/res.links.js"], { state: "changes-requested" })];
		const html = render({ cells: hiveCells(FILES, goals, [], NOW) });
		expect(html).toMatch(/aria-label="test\/res.links.js: changes requested, agent-19 at work"/);
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
		expect(html).toContain('aria-label="packages/auth/src/OrderSummary.tsx: building, agent-19 at work"');
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
		expect(html).toMatch(/data-state="building"[^>]* class="[^"]*\bopacity-30\b[^>]*aria-label="test\/res.links.js/);
		expect(html).not.toMatch(/data-state="landing"[^>]* class="[^"]*\bopacity-30\b/);
	});

	it("says while the tree loads, when it can't be read, and when the branch is empty", () => {
		expect(render({ cells: undefined })).toContain("Reading the tree…");
		expect(render({ cells: undefined, error: "no commits" })).toContain("The tree couldn&#x27;t be read: no commits");
		expect(render({ cells: { clusters: [], more: 0 } })).toContain("main has no files yet.");
	});
});
