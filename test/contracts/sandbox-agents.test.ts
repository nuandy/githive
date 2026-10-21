import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage } from "../fakes/env";
import { emptyUsage, runCall, type AgentTool } from "../../src/agent";
import { HOUSE, useHouseModel } from "../../src/models/payer";
import { madeWith } from "../../src/models/thread";
import type { BuildJob, BuilderState } from "../../src/builder";
import type { ReviewJob, ReviewerState } from "../../src/reviewer";
import { INBOX, TURN_IN_FLIGHT } from "../../src/sandbox";

// What builders and reviewers do differently in their shared container base:
// only builders guard pushes, a builder at work takes a second rejection into its next turn, and a reviewer
// rechecking a change it rejected continues that review's conversation.

const model = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock("../../src/models/clients", () => ({ modelClient: () => ({ turn: model.turn }) }));

const { Builder } = await import("../../src/builder");
const { Reviewer } = await import("../../src/reviewer");

// GitHive's own runs need a house model, which a Worker's entry names; here it's a stand-in.
const HOUSE_MODEL = { provider: "openai", model: "gpt-6-luna", apiKey: "test" } as const;
useHouseModel(() => HOUSE_MODEL);

const job: BuildJob = {
	repo: "project--a-1",
	remote: "https://git.test/a.git",
	token: "write-a",
	base: { remote: "https://git.test/base.git", token: "read-base" },
	project: "project",
	branch: "main",
	verify: [],
	change: "a-1",
	ref: "changes/a-1",
	agent: "agent-a",
	intent: "Build A",
	claim: ["src/a/"],
	others: [],
	payer: HOUSE,
};
const reviewJob: ReviewJob = { ...job, role: "tests", head: "h1", baseCommit: "b0" };

/** A container whose commands answer from a script, recording what ran. */
function fakeContainer() {
	const ran: string[][] = [];
	const container = {
		running: true,
		destroy: vi.fn(async () => undefined),
		setInactivityTimeout: vi.fn(async () => undefined),
		exec: vi.fn(async (cmd: string[]) => {
			const args = cmd.slice(4);
			ran.push(args);
			let text = "";
			if (args.includes("ls-remote")) text = "abc\trefs/heads/main\n";
			else if (args.includes("rev-parse")) text = "def\n";
			return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(text) }) };
		}),
	};
	return { container, ran };
}

class BuilderHarness extends Builder {
	callGit(args: string[], as: BuildJob = job) {
		return this.git(as, args);
	}
	getTools(state: BuilderState): AgentTool[] {
		return this.tools(job, state);
	}
	put(state: BuilderState) {
		return this.save(state);
	}
}

class ReviewerHarness extends Reviewer {
	callGit(args: string[]) {
		return this.git(reviewJob, args);
	}
	getTools(state: ReviewerState): AgentTool[] {
		return this.tools(reviewJob, state);
	}
}

let storage: FakeStorage;
let box: ReturnType<typeof fakeContainer>;
let builder: BuilderHarness;

beforeEach(() => {
	vi.clearAllMocks();
	storage = new FakeStorage();
	box = fakeContainer();
	builder = new BuilderHarness({ storage, container: box.container } as never, { OPENAI_API_KEY: "test" } as never);
});

describe("pushes", () => {
	it("a builder refuses a push it doesn't recognize, without running it", async () => {
		const result = await builder.callGit(["push", "origin", "HEAD:other"]);
		expect(result).toEqual({ exitCode: 1, output: expect.stringMatching(/^Refusing an unrecognized builder push/) });
		expect(box.ran).toEqual([]);
	});

	it("a builder pushes to its change branch, checking it on origin first, and remembers what it pushed", async () => {
		const result = await builder.callGit(["push", "-q", "origin", "HEAD:refs/heads/changes/a-1"]);
		expect(result.exitCode).toBe(0);
		expect(box.ran.find((args) => args.includes("ls-remote"))).toContain("refs/heads/changes/a-1");
		expect(
			box.ran.map((args) => args.find((a) => ["ls-remote", "merge-base", "push", "rev-parse"].includes(a))),
		).toEqual(["ls-remote", "merge-base", "push", "rev-parse"]);
		expect(await storage.get("builder-last-pushed-head")).toBe("def");
	});

	it("a builder refuses to push to main, without running it", async () => {
		const result = await builder.callGit(["push", "-q", "origin", "HEAD:main"]);
		expect(result).toEqual({
			exitCode: 1,
			output: expect.stringMatching(/^Refusing an unrecognized builder push.*changes\/a-1/),
		});
		expect(box.ran).toEqual([]);
	});

	it("a reviewer's git commands run as given", async () => {
		const reviewer = new ReviewerHarness({ storage, container: box.container } as never, {} as never);
		await reviewer.callGit(["push", "origin", "HEAD:other"]);
		expect(box.ran).toHaveLength(1);
		expect(await storage.get("builder-last-pushed-head")).toBeUndefined();
	});

	it("only a builder's run_command refuses history rewrites", async () => {
		const command = JSON.stringify({ command: "git push --force origin HEAD:changes/a-1" });
		const fresh = { status: "working", log: [], pushes: 1 } as unknown as BuilderState;
		expect(await runCall(builder.getTools(fresh), "run_command", command)).toMatch(/^Command refused/);
		expect(fresh.log.at(-1)?.event).toMatch(/blocked unsafe git command/);
		const reviewer = new ReviewerHarness({ storage, container: box.container } as never, {} as never);
		expect(
			await runCall(
				reviewer.getTools({ status: "working", log: [] } as unknown as ReviewerState),
				"run_command",
				command,
			),
		).toMatch(/^exit code 0/);
	});
});

describe("a container that stops answering", () => {
	it("is destroyed mid-command, so the next turn starts with a fresh one, and the agent hears why", async () => {
		vi.useFakeTimers();
		try {
			// Nothing it's asked to run comes back, not even the quick checks on it.
			box.container.exec.mockImplementation(async () => ({ output: () => new Promise<never>(() => undefined) }));
			const state = { status: "working", log: [], pushes: 0 } as unknown as BuilderState;
			const ran = runCall(builder.getTools(state), "run_command", JSON.stringify({ command: "npm test" }));
			await vi.advanceTimersByTimeAsync(75_000);
			expect(await ran).toBe("run_command failed: the container stopped answering");
			expect(box.container.destroy).toHaveBeenCalledWith("the container stopped answering");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("revising", () => {
	it("keeps a rejection that arrives mid-turn for the builder's next turn", async () => {
		const working = { status: "working", log: [], pushes: 1, revisions: 1, turns: 4 } as unknown as BuilderState;
		await storage.put("job", job);
		await builder.put(working);
		await storage.put(TURN_IN_FLIGHT, "turn-1");
		expect(await builder.revise("Second review: the timer never stops.")).toBe("revising");
		expect(await storage.get(INBOX)).toEqual(["Second review: the timer never stops."]);
	});
});

describe("rechecking", () => {
	const house = madeWith(HOUSE_MODEL);
	const handed = {
		madeWith: house,
		entries: [JSON.stringify({ responseId: "resp-rejected" })],
		pending: [{ kind: "result" as const, callId: "c1", output: "ok" }],
	};
	const recheckJob = { ...reviewJob, head: "h2", earlier: { head: "h1", findings: "no tests", conversation: handed } };
	const reviewer = () =>
		new Reviewer(
			{ storage: new FakeStorage(), container: fakeContainer().container } as never,
			{ OPENAI_API_KEY: "test" } as never,
		);
	type Turning = { turn(job: ReviewJob, state: ReviewerState): Promise<void> };
	const answered = {
		reply: { text: "thinking", calls: [], usage: emptyUsage() },
		append: [{ responseId: "resp-new" }],
	};

	it("continues the review that rejected the change, told what's new, instead of starting over", async () => {
		const agent = reviewer();
		await agent.start(recheckJob as never);
		const conversation = await agent.conversation();
		expect(conversation?.entries).toEqual(handed.entries);
		expect(conversation?.pending[0]).toEqual(handed.pending[0]);
		expect(JSON.stringify(conversation?.pending[1])).toContain("now at commit h2");
		model.turn.mockResolvedValueOnce(answered);
		const state = { ...(await agent.state())!, pending: conversation!.pending, handedOn: true };
		await (agent as unknown as Turning).turn(recheckJob as never, state as ReviewerState);
		expect(model.turn.mock.calls[0]![0]).toMatchObject({
			history: [{ responseId: "resp-rejected" }],
			inputs: conversation!.pending,
		});
		expect((await agent.conversation())?.entries).toEqual([...handed.entries, '{"responseId":"resp-new"}']);
	});

	it("starts afresh when that conversation can't be continued", async () => {
		const agent = reviewer();
		await agent.start(recheckJob as never);
		const conversation = (await agent.conversation())!;
		model.turn.mockRejectedValueOnce(new Error("Previous response not found")).mockResolvedValueOnce(answered);
		const state = { turns: 0, log: [], usage: emptyUsage(), pending: conversation.pending, handedOn: true };
		await (agent as unknown as Turning).turn(recheckJob as never, state as unknown as ReviewerState);
		const retried = model.turn.mock.calls[1]![0] as { history: unknown[]; inputs: { text: string }[] };
		expect(retried.history).toEqual([]);
		expect(retried.inputs[0]!.text).toContain("Review change a-1");
		expect(state.log.some((entry: { event: string }) => entry.event.includes("starting afresh"))).toBe(true);
	});

	it("starts its conversation again when its payer's model changed", async () => {
		const agent = reviewer();
		await agent.start({
			...recheckJob,
			earlier: { ...recheckJob.earlier, conversation: { ...handed, madeWith: "x" } },
		} as never);
		model.turn.mockResolvedValueOnce(answered);
		const state = { turns: 0, log: [], usage: emptyUsage(), pending: handed.pending, handedOn: true };
		await (agent as unknown as Turning).turn(recheckJob as never, state as unknown as ReviewerState);
		const asked = model.turn.mock.calls[0]![0] as { history: unknown[]; inputs: { text: string }[] };
		expect(asked.history).toEqual([]);
		expect(asked.inputs[0]!.text).toContain("Review change a-1");
	});
});
