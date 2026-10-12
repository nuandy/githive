import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";
import { branchPushOf, changePushOf, headsForClaims, notePushEvents, type PushedEvent } from "../src/push-events";

const { RepoCache } = await import("../src/repo-cache");

// Pushes as Artifacts reports them: a push to a change's branch on an agent's
// fork is noted in its project's RepoCache, nothing else is, and a head an
// event noted counts only for the agent whose fork took it.

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

const event = (
	repoName: string,
	ref: string,
	after: string,
	at = "2026-10-10T12:00:00.000Z",
	namespace = "blueprint",
): PushedEvent => ({
	type: "cf.artifacts.repo.pushed",
	source: { namespace, repoName },
	payload: { ref, after },
	metadata: { eventTimestamp: at },
});

describe("a push event's change", () => {
	it("is a push to changes/<change> on an agent's fork, in this namespace", () => {
		expect(
			changePushOf(event("fork--nuandy--web--agent--agent-7", "refs/heads/changes/fix-nav", A), "blueprint"),
		).toEqual({
			projects: ["nuandy--web"],
			push: {
				change: "fix-nav",
				fork: "fork--nuandy--web--agent--agent-7",
				head: A,
				at: Date.parse("2026-10-10T12:00:00.000Z"),
			},
		});
	});

	it("is the branch deleted when the push leaves nothing", () => {
		expect(changePushOf(event("fork--p--agent--a", "refs/heads/changes/c", ZERO), "blueprint")?.push.head).toBeNull();
	});

	it("names every project a fork's name may belong to, when a name holds --agent-- twice", () => {
		expect(changePushOf(event("fork--x--agent--agent--a", "refs/heads/changes/c", A), "blueprint")?.projects).toEqual([
			"x",
			"x--agent",
		]);
	});

	it("is nothing for another namespace, a project, a seed, another branch, or a malformed event", () => {
		const none = [
			event("fork--p--agent--a", "refs/heads/changes/c", A, undefined, "blueprint-bench"),
			event("nuandy--web", "refs/heads/main", A),
			event("fork--p--seed--3", "refs/heads/changes/c", A),
			event("fork--p--agent--a", "refs/heads/main", A),
			event("fork--p--agent--a", "refs/heads/changes/", A),
			event("fork--p--c", "refs/heads/changes/c", A),
			event("fork--p--agent--a", "refs/heads/changes/c", "not-a-commit"),
			event("fork--p--agent--a", "refs/heads/changes/c", A, "not a time"),
			{ ...event("fork--p--agent--a", "refs/heads/changes/c", A), type: "cf.artifacts.repo.created" },
			{},
		];
		for (const body of none) expect(changePushOf(body, "blueprint")).toBeNull();
	});
});

describe("a push event's branch", () => {
	const moved = (repoName: string, ref: string, after: string, before?: string): PushedEvent => ({
		...event(repoName, ref, after),
		payload: { ref, after, ...(before === undefined ? {} : { before }) },
	});
	const at = Date.parse("2026-10-10T12:00:00.000Z");

	it("is a push to a branch of a project's own repo, with where the branch was", () => {
		expect(branchPushOf(moved("nuandy--web", "refs/heads/main", B, A), "blueprint")).toEqual({
			repo: "nuandy--web",
			branch: "main",
			before: A,
			after: B,
			at,
		});
		expect(branchPushOf(moved("p", "refs/heads/feature/x", B), "blueprint")).toEqual({
			repo: "p",
			branch: "feature/x",
			after: B,
			at,
		});
	});

	it("says when the push made the branch, or deleted it", () => {
		expect(branchPushOf(moved("p", "refs/heads/main", B, ZERO), "blueprint")).toMatchObject({ before: null, after: B });
		expect(branchPushOf(moved("p", "refs/heads/main", ZERO, A), "blueprint")).toMatchObject({ before: A, after: null });
	});

	it("is nothing for a fork, a records repo, a note, another namespace, or a malformed event", () => {
		const none = [
			moved("fork--p--agent--a", "refs/heads/changes/c", A),
			moved("fork--p--seed--3", "refs/heads/main", A),
			moved("records--p--0", "refs/heads/main", A),
			moved("p", "refs/notes/githive-claims/p", A),
			moved("p", "refs/heads/", A),
			moved("p", "refs/heads/main", "not-a-commit"),
			moved("p", "refs/heads/main", A, "not-a-commit"),
			{ ...moved("p", "refs/heads/main", A), source: { namespace: "blueprint-bench", repoName: "p" } },
			{ ...moved("p", "refs/heads/main", A), metadata: { eventTimestamp: "not a time" } },
			{},
		];
		for (const body of none) expect(branchPushOf(body, "blueprint")).toBeNull();
	});
});

describe("the queue consumer", () => {
	const message = (body: unknown) => ({ body, ack: vi.fn(), retry: vi.fn() });
	const envWith = (
		notePushes: (project: string, pushes: unknown[]) => Promise<void>,
		namespace: string | null = "blueprint",
	) =>
		({
			...(namespace ? { ARTIFACTS_NAMESPACE: namespace } : {}),
			REPO_CACHE: {
				getByName: (name: string) => ({
					notePushes: (pushes: unknown[]) => notePushes(name.replace(/^repo:/, ""), pushes),
				}),
			},
		}) as unknown as Env;

	it("notes a batch's pushes with one call a project, and acks every message", async () => {
		const calls: [string, number][] = [];
		const messages = [
			message(event("fork--p--agent--a", "refs/heads/changes/c1", A)),
			message(event("fork--p--agent--b", "refs/heads/changes/c2", B)),
			message(event("fork--q--agent--a", "refs/heads/changes/c3", A)),
			message(event("p", "refs/heads/main", A)),
		];
		await notePushEvents(
			{ messages } as unknown as MessageBatch<unknown>,
			envWith(async (project, pushes) => void calls.push([project, pushes.length])),
		);
		expect(calls.sort()).toEqual([
			["p", 2],
			["q", 1],
		]);
		for (const m of messages) expect([m.ack.mock.calls.length, m.retry.mock.calls.length]).toEqual([1, 0]);
	});

	it("has the messages a project's noting failed for delivered again, once each", async () => {
		const messages = [
			message(event("fork--x--agent--agent--a", "refs/heads/changes/c", A)),
			message(event("fork--y--agent--a", "refs/heads/changes/d", A)),
		];
		await notePushEvents(
			{ messages } as unknown as MessageBatch<unknown>,
			envWith(async (project) => {
				if (project === "x--agent") throw new Error("Durable Object is overloaded");
			}),
		);
		expect([messages[0]!.ack.mock.calls.length, messages[0]!.retry.mock.calls.length]).toEqual([0, 1]);
		expect([messages[1]!.ack.mock.calls.length, messages[1]!.retry.mock.calls.length]).toEqual([1, 0]);
	});

	it("notes nothing without its namespace set", async () => {
		const noted = vi.fn(async () => undefined);
		const messages = [message(event("fork--p--agent--a", "refs/heads/changes/c", A))];
		await notePushEvents({ messages } as unknown as MessageBatch<unknown>, envWith(noted, null));
		expect(noted).not.toHaveBeenCalled();
		expect(messages[0]!.ack).toHaveBeenCalledOnce();
	});
});

describe("heads kept from reads and pushes", () => {
	const cache = () => new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);

	it("keeps the newest of each change's, whichever told of it, an event late or twice", async () => {
		const live = cache();
		await live.notePushes([{ change: "c", fork: "f", head: B, at: 2_000 }]);
		// A read that began before that push saw the older head: it doesn't replace the push.
		await live.noteHeads({ c: A }, 1_000);
		expect(await live.knownHeads(["c"])).toEqual({ c: { head: B, at: 2_000, fork: "f" } });
		// The same event again, and an older one late: nothing changes.
		await live.notePushes([
			{ change: "c", fork: "f", head: B, at: 2_000 },
			{ change: "c", fork: "f", head: A, at: 1_500 },
		]);
		expect(await live.knownHeads(["c"])).toEqual({ c: { head: B, at: 2_000, fork: "f" } });
		// A read begun after it replaces it.
		await live.noteHeads({ c: A }, 3_000);
		expect(await live.knownHeads(["c"])).toEqual({ c: { head: A, at: 3_000 } });
		// And a deletion pushed later still is noted as nothing pushed.
		await live.notePushes([{ change: "c", fork: "f", head: null, at: 4_000 }]);
		expect((await live.knownHeads(["c"])).c!.head).toBeNull();
	});

	it("counts an event's head only for the agent whose fork took it", async () => {
		const kept = {
			read: { head: A, at: 1 },
			own: { head: A, at: 2, fork: "fork--p--agent--a" },
			other: { head: B, at: 3, fork: "fork--p--agent--mallory" },
		};
		const claims = [
			{ change: "read", agent: "b" },
			{ change: "own", agent: "a" },
			{ change: "other", agent: "a" },
			{ change: "unseen", agent: "a" },
		];
		const forkOf = vi.fn(async (agent: string) => `fork--p--agent--${agent}`);
		expect(await headsForClaims(kept, claims, forkOf)).toEqual({
			read: { head: A, at: 1 },
			own: { head: A, at: 2, pushed: true },
		});
		expect(forkOf).toHaveBeenCalledTimes(1);
	});
});
