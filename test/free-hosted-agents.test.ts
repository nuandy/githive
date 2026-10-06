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
	releases: [] as unknown[],
	check: { main: { clean: true }, outsideClaim: [] } as unknown,
}));

vi.mock("../src/free/env", () => ({
	startFreeReviewers: hosted.startFreeReviewers,
	freeBuilderCredentials: async () => ({ token: "fork-write", base: { remote: "https://git.test/project.git", token: "read" } }),
	freeContextFor: (_env: unknown, by: string) => ({ by }),
	freeAgentName: (repo: string, change: string) => `free--${repo}--${change}`,
}));
vi.mock("../src/free/mcp", () => ({
	callFreeTool: vi.fn(async (name: string, args: unknown, ctx: { by: string }) => {
		if (name === "free_claim") hosted.claims.push({ args, by: ctx.by });
		if (name === "free_merge") hosted.merges.push({ args, by: ctx.by });
		if (name === "free_release") hosted.releases.push({ args, by: ctx.by });
		if (name === "free_check") return hosted.check;
		return { ok: true };
	}),
	// The repo's votes: wherever they're kept, a vote is recorded once.
	votesFor: () => ({ vote: vi.fn(async (input: unknown) => void hosted.votes.push(input)) }),
}));

const { Builder } = await import("../src/builder");
const { Reviewer } = await import("../src/reviewer");

const env = { COORDINATOR: { idFromName: () => { throw new Error("no Coordinator in coordinator-free mode"); } } };
const free = { repo: "project", change: "stats-1a2b", ref: "changes/stats-1a2b", agent: "blueprint-builder" };
const job: BuildJob = {
	taskId: "free:project", goal: "Add stats", slice: { id: "stats-1a2b", title: "stats-1a2b", owns: ["src/stats/"], instructions: "Add stats", tests: [] },
	siblings: [], verify: ["npm test"], repo: "free--project--stats-1a2b",
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
	hosted.releases = [];
	hosted.check = { main: { clean: true }, outsideClaim: [] };
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
		// Against the project's main (origin may be the change's fork), so merged-in main isn't counted.
		expect(b.ran).toContainEqual(["git", "diff", "--name-only", "base/main...HEAD"]);
	});

	it("checks its change against main after each push, and tells the model what would conflict", async () => {
		hosted.check = { head: "h9", main: { head: "m1", clean: false, conflicts: ["src/stats/index.ts"] }, outsideClaim: [] };
		const b = builder({ "rev-list --count": "1" });
		const said = await b.run("commit_and_push", { message: "stats" });
		expect(said).toMatch(/conflicts with the project's branch in src\/stats\/index\.ts/);
		expect(b.state.lastReport?.conflicts).toEqual([expect.objectContaining({ pair: ["base", "stats-1a2b"], heads: ["m1", "h9"], status: "conflict", files: ["src/stats/index.ts"] })]);
	});

	it("refreshes its claim with each push, so a working builder's claim never goes stale", async () => {
		const b = builder({ "rev-list --count": "1" });
		await b.run("commit_and_push", { message: "stats" });
		expect(hosted.claims).toEqual([{ args: { repo: "project", change: "stats-1a2b", agent: "blueprint-builder", paths: ["src/stats/"], intent: "Add stats" }, by: "service:blueprint-builder" }]);
	});

	it("releases its claim when it fails, so the paths don't wait to go stale", async () => {
		const agent = new Builder({ storage: new FakeStorage() } as never, env as never);
		await (agent as unknown as { onFailed(job: BuildJob, state: BuilderState): Promise<void> }).onFailed(job, { error: "out of turns" } as BuilderState);
		expect(hosted.releases).toEqual([{ args: { repo: "project", change: "stats-1a2b", agent: "blueprint-builder", reason: "the hosted builder failed: out of turns" }, by: "service:blueprint-builder" }]);
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

describe("Blueprint's builder, sent back by review", () => {
	/** A builder that finished `revisions` revisions ago. */
	async function finished(revisions: number) {
		const storage = new FakeStorage();
		const agent = new Builder({ storage } as never, env as never);
		await storage.put("job", job);
		await storage.put("state", { status: "done", startedAt: "", turns: 3, toolCalls: 3, nudges: 0, usage: {}, log: [], pushes: 1, revisions } as unknown as BuilderState);
		return { agent, state: async () => (await storage.get<BuilderState>("state"))! };
	}

	it("resumes with the reviewer's feedback, as a revision", async () => {
		const b = await finished(0);
		expect(await b.agent.reviseFree("The tests reviewer rejected h1: no tests")).toBe("revising");
		const state = await b.state();
		expect(state).toMatchObject({ status: "queued", revisions: 1 });
		expect(JSON.stringify(state.pending)).toContain("no tests");
	});

	it("gives up after three revisions, releasing its claim for someone else", async () => {
		const b = await finished(3);
		expect(await b.agent.reviseFree("rejected again")).toBe("released");
		expect((await b.state()).status).toBe("done");
		expect(hosted.releases).toEqual([{ args: { repo: "project", change: "stats-1a2b", agent: "blueprint-builder", reason: "rejected after 3 revisions: rejected again" }, by: "service:blueprint-builder" }]);
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

	it("rejects, then sends the change back to Blueprint's builder instead of merging", async () => {
		const reviseFree = vi.fn(async () => "revising");
		const reviewer = new Reviewer({ storage: new FakeStorage() } as never, { ...env, BUILDER: { getByName: (name: string) => (name === "free--project--stats-1a2b" ? { reviseFree } : null) } } as never);
		const review = { ...job, role: "tests", head: "h1", baseCommit: "b0", free: { ...free, mergeWhenApproved: true } } as unknown as ReviewJob;
		const tools = (reviewer as unknown as { tools(job: ReviewJob, state: ReviewerState): AgentTool[] }).tools(review, { log: [] } as unknown as ReviewerState);
		await tools.find((t) => t.name === "submit_verdict")!.run({ verdict: "reject", summary: "no tests", evidence: "src/stats has no test file" } as never);
		expect(hosted.votes).toEqual([expect.objectContaining({ commit: "h1", verdict: "reject" })]);
		expect(hosted.merges).toEqual([]);
		expect(reviseFree).toHaveBeenCalledWith(expect.stringMatching(/tests reviewer rejected h1[\s\S]*no tests[\s\S]*src\/stats has no test file/));
	});
});
