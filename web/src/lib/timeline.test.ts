import { describe, expect, it } from "vitest";
import { ago, approve, makeChange, reject } from "../test/fixtures";
import { buildTimeline, classifyHistory, historyForChange } from "./timeline";

const gate = { status: "passed" as const, head: "h1", baseHead: "b", at: ago(5), excluded: [], result: { passed: true, head: "h1", baseHead: "b", results: [{ command: "npm test", exitCode: 0, output: "ok" }], at: ago(5) } };

describe("buildTimeline from the change record alone (older servers)", () => {
	it("orders opening, reviews, checks and the merge by time", () => {
		const change = makeChange({
			status: "integrated",
			openedAt: ago(120),
			openedBy: "service:abc/agent-a",
			endedAt: ago(1),
			head: "h1",
			touched: ["src/stats/a.ts", "src/stats/b.ts"],
			reviewHead: "h1",
			reviews: [approve("security", "h1", ago(20)), approve("tests", "h1", ago(30), "suite passes")],
			gate,
		});
		const items = buildTimeline(change, { history: null });
		expect(items.map((item) => item.kind)).toEqual(["opened", "pushed", "review", "review", "checks", "merged"]);
		expect(items[0].text).toBe("agent-a opened this change, claiming src/stats/");
		expect(items[1].text).toBe("latest push: 2 files changed");
		expect(items[2].review?.reviewer).toBe("tests");
		expect(items[4]).toMatchObject({ text: "checks passed", tone: "good" });
		expect(items[5]).toMatchObject({ text: "merged into main" });
	});

	it("keeps untimed opening first and an untimed end last", () => {
		const change = makeChange({ status: "abandoned", reviewHead: "h1", reviews: [reject("tests", "h1", ago(3))] });
		expect(buildTimeline(change).map((item) => item.kind)).toEqual(["opened", "review", "abandoned"]);
	});

	it("shows feedback that sent the change back right after the verdicts on that commit", () => {
		const change = makeChange({ reviewHead: "h2", sentBackFor: "h1", revisions: 1, lastFeedback: "Fix the slice tests", reviews: [reject("tests", "h1", ago(30))], waivers: [{ head: "h2", by: "person:abc123", reason: "Trust it", at: ago(2) }] });
		const items = buildTimeline(change);
		expect(items.map((item) => item.kind)).toEqual(["opened", "review", "changes-requested", "waiver"]);
		expect(items[2]).toMatchObject({ text: "sent back to the agent (revision 1)", body: "Fix the change tests" });
		expect(items[3]).toMatchObject({ text: "person abc123 approved it without full review", body: "Trust it" });
	});

	it("uses the builder's pushes, with their commit messages, when there is no log", () => {
		const change = makeChange({ head: "h1", openedAt: ago(60) });
		const items = buildTimeline(change, {
			builderLog: [
				{ at: ago(50), event: "run: npm test" },
				{ at: ago(40), event: "pushed: Add the stats page" },
				{ at: ago(30), event: "parked while waiting for r1" },
			],
		});
		expect(items.map((item) => [item.kind, item.text, item.body])).toEqual([
			["opened", "opened this change, claiming src/stats/", undefined],
			["pushed", "pushed a commit", "Add the stats page"],
			["agent", "builder parked while waiting for r1", undefined],
		]);
	});
});

describe("buildTimeline with the repo's decision log", () => {
	const history = [
		{ at: ago(120), text: 'Change add-stats opened by service token abc: "Add stats page", claiming src/stats/. Intent: stats', commit: "s0" },
		{ at: ago(110), text: "Change fix-login opened by someone", commit: "s0" },
		{ at: ago(60), text: "add-stats pushed a1b2c3d: 4 files changed; Merge-ahead: no conflicts", commit: "a1b2c3d" },
		{ at: ago(50), text: "add-stats ready for review at a1b2c3d", commit: "a1b2c3d" },
		{ at: ago(30), text: "add-stats: tests reviewer approved: suite passes", commit: "a1b2c3d" },
		{ at: ago(29), text: "add-stats: quorum approved", commit: "a1b2c3d" },
		{ at: ago(5), text: "add-stats: gate passed on base 1234567: npm test", commit: "a1b2c3d" },
		{ at: ago(1), text: "add-stats integrated into the task base", commit: "a1b2c3d" },
	];
	const change = makeChange({
		status: "integrated",
		head: "a1b2c3d",
		reviewHead: "a1b2c3d",
		reviews: [approve("tests", "a1b2c3d", ago(30), "suite passes")],
		gate: { ...gate, head: "a1b2c3d" },
	});

	it("keeps only entries naming this change, by whole word", () => {
		expect(historyForChange(history, "add-stats")).toHaveLength(7);
		expect(historyForChange(history, "fix-login")).toHaveLength(1);
		expect(historyForChange(history, "add")).toHaveLength(0);
	});

	it("takes reviews and the latest checks run from the record, everything else from the log", () => {
		const items = buildTimeline(change, {
			history,
			ids: ["add-stats", "fix-login"],
			builderLog: [{ at: new Date(Date.parse(ago(60)) - 20_000).toISOString(), event: "pushed: Add the stats page" }],
		});
		expect(items.map((item) => item.kind)).toEqual(["opened", "pushed", "review-requested", "review", "review-result", "checks", "merged"]);
		expect(items[0].text).toBe('Change add-stats opened by abc: "Add stats page", claiming src/stats/. Intent: stats');
		expect(items[1]).toMatchObject({ text: "add-stats pushed a1b2c3d: 4 files changed; no conflicts", body: "Add the stats page" });
		expect(items[3].review?.summary).toBe("suite passes");
		expect(items[5].gate?.status).toBe("passed");
		expect(items[6].text).toBe("add-stats merged into main");
		expect(items.filter((item) => item.kind === "merged")).toHaveLength(1);
	});

	it("splits a multi-line log entry into a line and its body", () => {
		const sentBack = [{ at: ago(10), text: "add-stats sent back to its builder (revision 1 of 3):\n- tests rejected: slice tests fail", commit: "a1b2c3d" }];
		const [, item] = buildTimeline(makeChange({ openedAt: ago(20) }), { history: sentBack });
		expect(item).toMatchObject({ kind: "changes-requested", text: "add-stats sent back to its builder (revision 1 of 3):", body: "- tests rejected: change tests fail" });
	});
});

describe("classifyHistory", () => {
	it("recognizes the decisions the coordinator records", () => {
		expect(classifyHistory("Change x opened by y").kind).toBe("opened");
		expect(classifyHistory("Change x abandoned, freeing src/: expired").kind).toBe("abandoned");
		expect(classifyHistory("x: quorum waived by someone: ok").kind).toBe("waiver");
		expect(classifyHistory("x: gate failed on base abc").tone).toBe("bad");
		expect(classifyHistory("x needs a human: stuck").kind).toBe("needs-you");
		expect(classifyHistory("Message from a to x's builder (delivered): hi").kind).toBe("message");
		expect(classifyHistory("Builder for slice x parked").kind).toBe("note");
	});
});
