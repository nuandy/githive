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
	it("opens the busy folder up, and draws a focusable, labelled cell in each one's stage", () => {
		const html = render();
		expect(visibleText(html)).toContain("test/ · 2 agents at work");
		expect(html).toMatch(
			/data-state="building"[^>]*role="button" tabindex="0" aria-label="test\/res.links.js: building, agent-19 at work"/,
		);
		expect(html).toMatch(/data-state="landing"[^>]*aria-label="test\/res.type.js: landing, agent-16 at work"/);
		// Its blinking lamp.
		expect(html).toMatch(/<circle class="[^"]*animate-hive-cell-blink[^"]*"/);
		expect(html).toMatch(/data-state="landed"[^>]*aria-label="test\/req.is.js: agent-7 landed a change here lately"/);
		// The agents' chips: their numbers.
		expect(html).toMatch(/<circle [^>]*r="7.5"><\/circle><text[^>]*>19<\/text>/);
	});

	it("dims what an agent filter leaves out", () => {
		const html = render({ filter: { kind: "agent", agent: "agent-16" } });
		expect(html).toMatch(/data-state="building" class="[^"]*\bopacity-30\b[^>]*aria-label="test\/res.links.js/);
		expect(html).not.toMatch(/data-state="landing" class="[^"]*\bopacity-30\b/);
	});

	it("says while the tree loads, when it can't be read, and when the branch is empty", () => {
		expect(render({ cells: undefined })).toContain("Reading the tree…");
		expect(render({ cells: undefined, error: "no commits" })).toContain("The tree couldn&#x27;t be read: no commits");
		expect(render({ cells: { clusters: [], more: 0 } })).toContain("main has no files yet.");
	});
});
