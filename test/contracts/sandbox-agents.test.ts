import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage } from "../fakes/env";
import { runCall, type AgentTool } from "../../src/agent";
import type { BuildJob, BuilderState } from "../../src/builder";
import type { ReviewJob, ReviewerState } from "../../src/reviewer";

// What builders and reviewers do differently in their shared container base:
// only builders guard pushes, park, and take wake events.

const openai = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
	default: class {
		responses = { create: openai.create };
	},
}));

const { Builder } = await import("../../src/builder");
const { Reviewer } = await import("../../src/reviewer");

const MINUTE = 60_000;
const job = {
	taskId: "t1", goal: "goal", repo: "t1--a", remote: "https://git.test/a.git", token: "write-a",
	base: { remote: "https://git.test/base.git", token: "read-base" },
	slice: { id: "a", title: "A", owns: ["src/a/"], instructions: "Build A" }, siblings: [], contracts: [], verify: [],
} as BuildJob;
const reviewJob = { ...job, role: "tests", head: "h1", baseCommit: "b0" } as unknown as ReviewJob;
const credentials = { token: "fresh-write", base: { remote: "https://git.test/base.git", token: "fresh-read" } };

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
			const text = args.includes("ls-remote") ? "abc\trefs/heads/main\n" : args.includes("rev-parse") ? "def\n" : "";
			return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(text) }) };
		}),
	};
	return { container, ran };
}

const rpc = {
	parkedBuilderTimedOut: vi.fn(async () => undefined),
	agentStopped: vi.fn(async () => undefined),
	flagSlice: vi.fn(async () => undefined),
};

class BuilderHarness extends Builder {
	/** Runs while the list_files tool executes, that is, in the middle of a turn. */
	duringTool: (() => Promise<unknown>) | null = null;
	protected override coordinator() {
		return rpc as never;
	}
	protected override async exec(cmd: string[], cwd?: string, stdin?: string) {
		if (cmd[1] === "ls-files" && this.duringTool) await this.duringTool();
		return super.exec(cmd, cwd, stdin);
	}
	callGit(args: string[]) {
		return this.git(job, args);
	}
	getTools(state: BuilderState): AgentTool[] {
		return this.tools(job, state);
	}
	put(state: BuilderState) {
		return this.save(state);
	}
}

class ReviewerHarness extends Reviewer {
	protected override coordinator() {
		return rpc as never;
	}
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

const state = async () => (await storage.get<BuilderState>("state"))!;
async function withState(fields: Partial<BuilderState>) {
	await builder.start(job);
	await builder.put({ ...(await state()), ...fields });
}

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

	it("a builder checks origin before pushing and remembers what it pushed", async () => {
		const result = await builder.callGit(["push", "-q", "origin", "HEAD:main"]);
		expect(result.exitCode).toBe(0);
		expect(box.ran.map((args) => args.find((a) => ["ls-remote", "merge-base", "push", "rev-parse"].includes(a)))).toEqual(["ls-remote", "merge-base", "push", "rev-parse"]);
		expect(await storage.get("builder-last-pushed-head")).toBe("def");
	});

	it("a reviewer's git commands run as given", async () => {
		const reviewer = new ReviewerHarness({ storage, container: box.container } as never, {} as never);
		await reviewer.callGit(["push", "origin", "HEAD:other"]);
		expect(box.ran).toHaveLength(1);
		expect(await storage.get("builder-last-pushed-head")).toBeUndefined();
	});

	it("only a builder's run_command refuses history rewrites", async () => {
		const command = JSON.stringify({ command: "git push --force origin HEAD:main" });
		const fresh = { status: "working", log: [], pushes: 1 } as unknown as BuilderState;
		expect(await runCall(builder.getTools(fresh), "run_command", command)).toMatch(/^Command refused/);
		expect(fresh.log.at(-1)?.event).toMatch(/blocked unsafe git command/);
		const reviewer = new ReviewerHarness({ storage, container: box.container } as never, {} as never);
		expect(await runCall(reviewer.getTools({ status: "working", log: [] } as unknown as ReviewerState), "run_command", command)).toMatch(/^exit code 0/);
	});
});

describe("parking", () => {
	it("parks at once between turns, and waits for the deadline", async () => {
		await withState({ status: "working" });
		const parkedAt = new Date().toISOString();
		await builder.park(parkedAt, ["r1"]);
		expect(await state()).toMatchObject({ status: "parked", parkedAt, waitingRequestIds: ["r1"] });
		expect((await state()).log.at(-1)?.event).toBe("parked while waiting for r1");
		expect(box.container.destroy).toHaveBeenCalledWith("builder parked");
		expect(storage.alarm).toBe(Date.parse(parkedAt) + 30 * MINUTE);
	});

	it("leaves a park for after the turn in flight", async () => {
		await withState({ status: "working" });
		await storage.put("sandbox-turn-in-flight", "turn-1");
		const before = Date.now();
		await builder.park("2026-10-04T00:00:00.000Z", ["r1"]);
		expect((await state()).status).toBe("working");
		expect(await storage.get("sandbox-park-command")).toEqual({ parkedAt: "2026-10-04T00:00:00.000Z", waitingFor: ["r1"], applied: false });
		expect(storage.alarm).toBeGreaterThanOrEqual(before + 8 * MINUTE + 5_000);
	});

	it("defers a wake event that arrives during a turn, and takes each event once", async () => {
		await withState({ status: "working" });
		await storage.put("sandbox-turn-in-flight", "turn-1");
		expect(await builder.wake("e1", "hello", credentials)).toBe("deferred");
		expect(await builder.wake("e1", "hello", credentials)).toBe("ignored");
		expect(await storage.get("sandbox-deferred-wakes")).toEqual([{ eventId: "e1", message: "hello", credentials }]);
	});

	it("queues a wake event for a working builder's next turn, and resumes a parked one", async () => {
		await withState({ status: "working" });
		expect(await builder.wake("e1", "hello", credentials)).toBe("deferred");
		expect(await storage.get("inbox")).toEqual(["hello"]);
		await builder.put({ ...(await state()), status: "parked", parkedAt: new Date().toISOString() });
		expect(await builder.wake("e2", "resolved", credentials)).toBe("resumed");
		expect(await state()).toMatchObject({ status: "queued", parkedAt: undefined });
		expect(await storage.get("job")).toMatchObject({ token: "fresh-write", base: credentials.base });
		expect(await builder.wake("e2", "resolved", credentials)).toBe("ignored");
	});

	it("reports whether a park has timed out", async () => {
		await withState({ status: "parked", parkedAt: new Date(Date.now() - 31 * MINUTE).toISOString() });
		expect(await builder.markParkTimedOut()).toBe(true);
		await builder.put({ ...(await state()), parkedAt: new Date().toISOString() });
		expect(await builder.markParkTimedOut()).toBe(false);
	});

	it("tells the Coordinator once when a park times out", async () => {
		const parkedAt = new Date(Date.now() - 31 * MINUTE).toISOString();
		await withState({ status: "parked", parkedAt, waitingRequestIds: ["r1"] });
		await builder.alarm();
		await builder.alarm();
		expect(rpc.parkedBuilderTimedOut).toHaveBeenCalledOnce();
		expect(rpc.parkedBuilderTimedOut).toHaveBeenCalledWith("a", parkedAt);
		expect(await storage.get("sandbox-timed-out-park")).toBe(parkedAt);
		expect((await state()).log.at(-1)?.event).toBe("park timeout reported while waiting for r1");
	});

	it("waits for the deadline before reporting, and retries a report that failed", async () => {
		const parkedAt = new Date().toISOString();
		await withState({ status: "parked", parkedAt });
		await builder.alarm();
		expect(rpc.parkedBuilderTimedOut).not.toHaveBeenCalled();
		expect(storage.alarm).toBe(Date.parse(parkedAt) + 30 * MINUTE);

		const late = new Date(Date.now() - 31 * MINUTE).toISOString();
		await builder.put({ ...(await state()), parkedAt: late });
		rpc.parkedBuilderTimedOut.mockRejectedValueOnce(new Error("unreachable"));
		const before = Date.now();
		await builder.alarm();
		expect(storage.alarm).toBeGreaterThanOrEqual(before + MINUTE);
		expect(await storage.get("sandbox-timed-out-park")).toBeUndefined();
	});

	it("starts afresh, forgetting an earlier run's parking and pushes", async () => {
		for (const key of ["builder-last-pushed-head", "sandbox-park-command", "sandbox-deferred-wakes", "sandbox-delivered-wakes", "sandbox-timed-out-park", "inbox", "cancel"]) await storage.put(key, "old");
		await builder.start(job);
		for (const key of ["builder-last-pushed-head", "sandbox-park-command", "sandbox-deferred-wakes", "sandbox-delivered-wakes", "sandbox-timed-out-park", "inbox", "cancel"])
			expect(await storage.get(key)).toBeUndefined();
	});
});

describe("events during a turn", () => {
	const listFiles = { id: "resp-1", status: "completed", output: [{ type: "function_call", call_id: "c1", name: "list_files", arguments: '{"prefix":""}' }], output_text: "" };

	it("applies a park that arrived during the turn once the turn ends", async () => {
		await withState({ status: "working" });
		const parkedAt = new Date().toISOString();
		builder.duringTool = async () => {
			builder.duringTool = null;
			await builder.park(parkedAt, ["r1"]);
		};
		openai.create.mockResolvedValueOnce(listFiles);
		await builder.alarm();
		expect(await state()).toMatchObject({ status: "parked", parkedAt, waitingRequestIds: ["r1"] });
		expect(await storage.get("sandbox-park-command")).toBeUndefined();
		expect(await storage.get("sandbox-turn-in-flight")).toBeUndefined();
		expect(storage.alarm).toBe(Date.parse(parkedAt) + 30 * MINUTE);
	});

	it("delivers a wake that arrived during the turn once the turn ends", async () => {
		await withState({ status: "working" });
		builder.duringTool = async () => {
			builder.duringTool = null;
			expect(await builder.wake("e1", "resolved", credentials)).toBe("deferred");
		};
		openai.create.mockResolvedValueOnce(listFiles).mockRejectedValueOnce(new Error("stop here"));
		await builder.alarm();
		expect(await storage.get("sandbox-deferred-wakes")).toBeUndefined();
		expect(await storage.get("sandbox-delivered-wakes")).toEqual(["e1"]);
		expect(await storage.get("inbox")).toEqual(["resolved"]);
		expect((await state()).log.map((l) => l.event)).toContain("resolution event e1 queued for next turn");
		// The second turn saw the delivered message.
		expect(openai.create.mock.calls[1][0].input).toContainEqual({ role: "user", content: "resolved" });
	});
});
