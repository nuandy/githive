import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Live } from "../api";
import { agentState, ago, approve, makeChange, makeTask, reject } from "../test/fixtures";
import { availableActions, type ChangeActionsApi } from "./ChangeActions";
import { ChangePage, type ChangePageProps } from "./ChangePage";

const stubApi: ChangeActionsApi = {
	waive: vi.fn(async () => ({})),
	messageBuilder: vi.fn(async () => ({ delivered: "inbox" })),
	retryChecks: vi.fn(async () => ({})),
	abandon: vi.fn(async () => ({})),
	sliceDiff: vi.fn(async () => ({ base: "b", head: "h", unified: "", files: [], omitted: [] })),
};

const failedGate = {
	status: "failed" as const,
	head: "h1",
	baseHead: "b",
	at: ago(3),
	excluded: [],
	result: { passed: false, head: "h1", baseHead: "b", results: [{ command: "npm test", exitCode: 1, output: "1 failing test" }], at: ago(3) },
};

function render(overrides: Partial<ChangePageProps> = {}) {
	const change = overrides.change ?? makeChange({ openedAt: ago(120), openedBy: "service:abc/agent-a", external: true, head: "h1", touched: ["src/stats/a.ts", "src/stats/b.ts"] });
	const task = overrides.task ?? makeTask({ slices: [change] });
	return renderToStaticMarkup(<ChangePage task={task} change={change} repo="my-app" base="repos" tab="conversation" history={null} api={stubApi} onChanged={() => undefined} {...overrides} />);
}

describe("the change page", () => {
	it("names the project's own branch, whatever it is", () => {
		const change = makeChange({ status: "integrated", head: "h1", endedAt: ago(1) });
		const html = render({ change, task: makeTask({ branch: "master", slices: [change] }) });
		expect(html).toMatch(/merged <code[^>]*>changes\/add-stats<\/code> into <code[^>]*>master<\/code>/);
		expect(html).toContain("Merged into master");
		expect(html).not.toMatch(/into <code[^>]*>main</);
	});


	it("reads like a pull request header with Conversation, Files changed and Checks tabs", () => {
		const html = render();
		expect(html).toContain("Add stats page");
		expect(html).toMatch(/<strong>agent-a<\/strong> wants to merge <code[^>]*>changes\/add-stats<\/code> into <code[^>]*>main<\/code>/);
		expect(html).toContain("Draft");
		expect(html).toMatch(/aria-current="page"[^>]*>.*Conversation/);
		expect(html).toMatch(/Files changed<\/span><span class="counter">2<\/span>/);
		expect(html).toMatch(/Checks<\/span><span class="counter">1<\/span>/);
		expect(html).toContain("Add a stats page that shows weekly totals.");
		expect(html).toContain("claims src/stats/");
	});

	it("says merged or abandoned once a change has ended, and offers no actions", () => {
		const merged = makeChange({ status: "integrated", endedAt: ago(60), openedBy: "service:abc/agent-a" });
		const html = render({ change: merged, task: makeTask({ slices: [merged] }) });
		expect(html).toMatch(/<strong>agent-a<\/strong> merged <code[^>]*>changes\/add-stats<\/code> into <code[^>]*>main<\/code> 1 hour ago/);
		expect(html).toContain("Merged into main");
		expect(html).not.toMatch(/Abandon this change|Message the builder|Re-run checks/);
		const abandoned = makeChange({ status: "abandoned" });
		expect(render({ change: abandoned, task: makeTask({ slices: [abandoned] }) })).toContain("was abandoned");
	});

	it("shows reviews as cards with collapsible evidence, and reviewers in the sidebar", () => {
		const change = makeChange({ reviewHead: "h1", external: true, reviews: [approve("tests", "h1", ago(9), "suite passes"), { ...reject("security", "h1", ago(8), "token leaks"), evidence: "curl shows the token" }] });
		const html = render({ change, task: makeTask({ slices: [change] }) });
		expect(html).toContain("tests</strong> reviewer approved these changes");
		expect(html).toContain("suite passes");
		expect(html).toMatch(/<details class="timeline-card__evidence"><summary>Evidence<\/summary><pre tabindex="0">curl shows the token<\/pre>/);
		expect(html).toContain("Changes requested");
		expect(html).toMatch(/security.*can block/);
		expect(html).toContain("2 approvals required");
	});

	it("only offers actions that apply", () => {
		const external = makeChange({ external: true, reviewHead: "h1" });
		expect(availableActions(external, ["npm test"])).toEqual({ waive: false, message: false, retryChecks: false, abandon: true });
		const hostedFailed = makeChange({ external: false, reviewHead: "h1", reviews: [approve("tests", "h1"), approve("security", "h1")], gate: failedGate });
		expect(availableActions(hostedFailed, ["npm test"])).toEqual({ waive: false, message: true, retryChecks: true, abandon: true });
		const needsYou = makeChange({ external: true, attention: "Reviewers disagree", reviewHead: "h1" });
		expect(availableActions(needsYou, [])).toMatchObject({ waive: true, retryChecks: false });
		expect(availableActions(makeChange({ status: "opening" }), [])).toEqual({ waive: false, message: false, retryChecks: false, abandon: false });

		const html = render({ change: hostedFailed, task: makeTask({ slices: [hostedFailed] }) });
		expect(html).toContain("Re-run checks");
		expect(html).toContain("Message the builder");
		expect(html).toContain("Abandon this change");
		expect(html).not.toContain("Approve and merge anyway");
		expect(html).toContain("1 of 1 checks failed");
	});

	it("says it waits for a reviewer who can block, even with enough approvals", () => {
		const change = makeChange({ external: true, reviewHead: "h1", reviews: [approve("tests", "h1"), approve("api", "h1")] });
		const task = makeTask({ slices: [change], review: { reviewers: ["tests", "security", "api"], required: 2, vetoes: ["security"] } });
		const html = render({ change, task });
		expect(html).toContain("Waiting for security");
		expect(html).toContain("security can block it and must approve too");
		expect(html).not.toMatch(/>Approved</);
	});

	it("keeps the waiver unavailable until the diff under review has loaded", () => {
		const change = makeChange({ external: true, attention: "Reviewers disagree", reviewHead: "h1", lastFeedback: "tests rejected" });
		const html = render({ change, task: makeTask({ slices: [change] }) });
		expect(html).toContain("This change needs you");
		expect(html).toContain("Reviewers disagree");
		expect(html).toMatch(/<button type="submit" class="primary" disabled=""[^>]*>.*Approve and merge anyway<\/button>/);
		expect(html).toContain("Loading the changes under review");
	});

	it("shows the hosted builder's state, and what a paused builder waits on", () => {
		const change = makeChange({ external: false, openedBy: "blueprint-builder" });
		const task = makeTask({
			slices: [change],
			laneChangeRequests: [{ id: "r1", requester: "add-stats", owner: "api", path: "src/api/routes.ts", need: "Add route", reason: "UI needs it", status: "pending", createdAt: ago(10) }],
		});
		const agent: Live["agents"][number] = { id: "add-stats", builder: agentState({ status: "parked", parkedAt: ago(10), waitingRequestIds: ["r1"], log: [{ at: ago(10), event: "parked while waiting for r1" }] }), reviewers: [] };
		const html = render({ change, task, agent });
		expect(html).toContain("Paused, waiting on other changes");
		expect(html).toMatch(/Waiting on.*api.*src\/api\/routes\.ts/);
		expect(html).toContain("Requests to other claims");
		expect(html).toContain("Add route");
		expect(html).toContain("since 10 minutes ago");
	});

	it("warns about conflicts and edits outside the claim", () => {
		const change = makeChange({ outOfLane: ["README.md"] });
		const other = makeChange({ id: "docs", title: "Docs" });
		const task = makeTask({ slices: [change, other], checks: [{ pair: ["add-stats", "docs"], heads: ["a", "b"], status: "conflict", files: ["README.md"], checkedAt: ago(1) }] });
		const html = render({ change, task });
		expect(html).toContain("Conflicts with Docs (docs) in README.md");
		expect(html).toContain("Edits outside its claim");
		expect(html).toContain("This change has conflicts");
	});

	it("lists the changed files, and check outputs on the Checks tab", () => {
		const change = makeChange({ head: "h1", touched: ["src/stats/a.ts"], reviewHead: "h1", reviews: [approve("tests", "h1"), approve("security", "h1")], gate: failedGate });
		const files = render({ change, task: makeTask({ slices: [change] }), tab: "files" });
		expect(files).toContain("1 file changed");
		expect(files).toContain("src/stats/a.ts");
		const checks = render({ change, task: makeTask({ slices: [change] }), tab: "checks" });
		expect(checks).toContain("npm test");
		expect(checks).toContain("1 failing test");
		expect(checks).toMatch(/<details open="">/);
	});
});
