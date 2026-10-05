import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ago, approve, makeChange, makeTask } from "../test/fixtures";
import { activityFromHistory, RepoActivity } from "./RepoActivity";

const task = makeTask({ slices: [makeChange({ id: "add-stats", openedAt: ago(90), reviewHead: "h1", reviews: [approve("tests", "h1", ago(30))] })] });
const history = [
	{ at: ago(90), text: "Change add-stats opened by service token abc", commit: "s0" },
	{ at: ago(30), text: "add-stats: tests reviewer approved: suite passes", commit: "a1b2c3d4" },
	{ at: ago(1), text: "add-stats integrated into the task base", commit: "a1b2c3d4" },
];

describe("the Activity tab", () => {
	it("shows the decision log newest first, worded for people, with changes linked", () => {
		const entries = activityFromHistory(history, ["add-stats"]);
		expect(entries.map((entry) => entry.text)).toEqual(["add-stats merged into main", "add-stats: tests reviewer approved: suite passes", "Change add-stats opened by abc"]);
		const html = renderToStaticMarkup(<RepoActivity task={task} repo="my-app" base="repos" history={history} />);
		expect(html).toContain('<a href="#/repos/my-app/changes/add-stats">add-stats</a> merged into main');
		expect(html).toMatch(/Today|Yesterday/);
		expect(html).toContain("a1b2c3d");
	});

	it("falls back to the change records on a server without the log", () => {
		const html = renderToStaticMarkup(<RepoActivity task={task} repo="my-app" base="repos" history={null} />);
		expect(html).toMatch(/doesn.{1,6}t keep a full activity log yet/);
		expect(html).toContain("tests reviewer approved");
	});

	it("says when there is nothing yet, and when it is loading", () => {
		expect(renderToStaticMarkup(<RepoActivity task={makeTask()} repo="my-app" base="repos" history={[]} />)).toContain("No activity yet");
		expect(renderToStaticMarkup(<RepoActivity task={makeTask()} repo="my-app" base="repos" history={undefined} />)).toContain("Loading activity");
	});
});
