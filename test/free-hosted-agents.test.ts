import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../src/agent";
import type { BuildJob, BuilderState } from "../src/builder";
import type { ReviewJob, ReviewerState } from "../src/reviewer";
import { FakeStorage } from "./fakes/env";

// Blueprint's hosted agents in coordinator-free mode: the builder works on a
// branch of the project repo within its claim and asks for review when done;
// a reviewer votes, and, asked to, then tries the merge (which the toolkit
// refuses until the approvals are in). Neither calls a Coordinator. The
// container is stubbed: its git and shell calls are recorded and answered.

const hosted = vi.hoisted(() => ({
	startFreeReviewers: vi.fn(async () => ({ head: "h1", reviewers: ["tests"] })),
	claims: [] as unknown[],
	merges: [] as unknown[],
	votes: [] as unknown[],
}));

vi.mock("../src/free/env", () => ({
	startFreeReviewers: hosted.startFreeReviewers,
	freeContextFor: (_env: unknown, by: string) => ({ by }),
	freeAgentName: (repo: string, change: string) => `free--${repo}--${change}`,
}));
vi.mock("../src/free/mcp", () => ({
	callFreeTool: vi.fn(async (name: string, args: unknown, ctx: { by: string }) => {
		if (name === "free_claim") hosted.claims.push({ args, by: ctx.by });
		if (name === "free_merge") hosted.merges.push({ args, by: ctx.by });
		return { ok: true };
	}),
}));
vi.mock("../src/free/votes", () => ({ vote: vi.fn(async (_log: unknown, input: unknown) => void hosted.votes.push(input)) }));

const { Builder } = await import("../src/builder");
const { Reviewer } = await import("../src/reviewer");

const env = { COORDINATOR: { idFromName: () => { throw new Error("no Coordinator in coordinator-free mode"); } } };
const free = { repo: "project", change: "stats-1a2b", ref: "changes/stats-1a2b", agent: "blueprint-builder" };
const job: BuildJob = {
	taskId: "free:project", goal: "Add stats", slice: { id: "stats-1a2b", title: "stats-1a2b", owns: ["src/stats/"], instructions: "Add stats", tests: [] },
	siblings: [], contracts: [], verify: ["npm test"], repo: "free--project--stats-1a2b",
	remote: "https://git.test/project.git", token: "write", base: { remote: "https://git.test/project.git", token: "read" }, free,
};

/** A builder whose container answers: `outputs` maps a command (joined) to its output; everything else succeeds quietly. */
function builder(outputs: Record<string, string> = {}) {
	const agent = new Builder({ storage: new FakeStorage() } as never, env as never);
	const ran: string[][] = [];
	const answer = async (args: string[]) => {
		ran.push(args);
		const key = Object.keys(outputs).find((k) => args.join(" ").includes(k));
		return { exitCode: 0, output: key ? outputs[key] : "" };
	};
	Object.assign(agent, { exec: answer, git: async (_job: unknown, args: string[]) => answer(args) });
	const state = { pushes: 0, revisions: 0, log: [] } as unknown as BuilderState;
	const tools = (agent as unknown as { tools(job: BuildJob, state: BuilderState): AgentTool[] }).tools(job, state);
	const run = (name: string, args: object) => tools.find((t) => t.name === name)!.run(args as never);
	return { tools, run, ran, state };
}

beforeEach(() => {
	hosted.startFreeReviewers.mockClear();
	hosted.claims = [];
	hosted.merges = [];
	hosted.votes = [];
});

describe("Blueprint's builder, coordinator-free", () => {
	it("has the coordinator-free tools, and none that need a Coordinator", () => {
		const names = builder().tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["commit_and_push", "fetch_base", "extend_claim", "finish"]));
		for (const coordinatorOnly of ["request_lane_change", "answer_lane_change", "propose_contract_change", "wait_for_requests"]) expect(names).not.toContain(coordinatorOnly);
	});

	it("pushes to its change branch, and reports files outside its claim", async () => {
		const b = builder({ "rev-list --count": "1", "diff --name-only": "src/stats/index.ts\nsrc/router.ts" });
		const said = await b.run("commit_and_push", { message: "stats" });
		expect(b.ran).toContainEqual(["push", "-q", "origin", "HEAD:refs/heads/changes/stats-1a2b"]);
		expect(said).toMatch(/outside your claim: src\/router\.ts/);
		expect(b.state.lastReport?.outOfLane).toEqual(["src/router.ts"]);
	});

	it("extends its claim as itself", async () => {
		await builder().run("extend_claim", { paths: ["docs/stats.md"] });
		expect(hosted.claims).toEqual([{ args: { repo: "project", change: "stats-1a2b", agent: "blueprint-builder", paths: ["docs/stats.md"], intent: "Add stats" }, by: "service:blueprint-builder" }]);
	});

	it("finishes only with everything pushed, then asks the hosted reviewers, who merge once approved", async () => {
		const unpushed = builder({ "rev-list --count": "2" });
		unpushed.state.pushes = 1;
		expect(await unpushed.run("finish", { summary: "done" })).toMatch(/not pushed/i);
		expect(hosted.startFreeReviewers).not.toHaveBeenCalled();

		const b = builder({ "rev-list --count": "0" });
		b.state.pushes = 1;
		expect(await b.run("finish", { summary: "adds stats" })).toMatch(/review/i);
		expect(hosted.startFreeReviewers).toHaveBeenCalledWith(env, expect.objectContaining({ repo: "project", change: "stats-1a2b", summary: "adds stats", mergeWhenApproved: true }));
	});
});

describe("Blueprint's reviewer, coordinator-free", () => {
	it("votes, then tries the merge as the change's agent when asked to", async () => {
		const reviewer = new Reviewer({ storage: new FakeStorage() } as never, env as never);
		const review = { ...job, role: "tests", head: "h1", baseCommit: "b0", free: { ...free, mergeWhenApproved: true } } as unknown as ReviewJob;
		const state = { log: [] } as unknown as ReviewerState;
		const tools = (reviewer as unknown as { tools(job: ReviewJob, state: ReviewerState): AgentTool[] }).tools(review, state);
		await tools.find((t) => t.name === "submit_verdict")!.run({ verdict: "approve", summary: "fine", evidence: "npm test passes" } as never);
		expect(hosted.votes).toEqual([expect.objectContaining({ commit: "h1", reviewer: "blueprint-tests", role: "tests", verdict: "approve" })]);
		expect(hosted.merges).toEqual([{ args: { repo: "project", change: "stats-1a2b", agent: "blueprint-builder" }, by: "service:blueprint-reviewer:tests" }]);
	});
});
