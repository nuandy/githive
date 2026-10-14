import { describe, expect, it } from "vitest";
import type { Connection, MyAgent } from "../api";
import { ago } from "../test/fixtures";
import { gettingStarted } from "./gettingStarted";
import type { RepoRow } from "./repos";

// The Repositories page's "Get started": four steps that tick themselves from what the page can read.

const row = (name: string, more: Partial<RepoRow> = {}): RepoRow => ({
	name,
	open: 0,
	needsYou: 0,
	merged: 0,
	violations: 0,
	detailed: true,
	...more,
});
const agent = (more: Partial<MyAgent> = {}): MyAgent => ({
	id: "a1",
	ownerId: "u1",
	name: "builder",
	createdAt: ago(60),
	revokedAt: null,
	tokens: [],
	...more,
});
const app: Connection = { id: "g1", client: "Claude Code", agentId: "a1", agent: "robin/builder", createdAt: ago(5) };
const ticks = (start: ReturnType<typeof gettingStarted>) => start.steps.map((step) => step.done);

describe("getting started", () => {
	it("starts with nothing ticked, the first step next, and can't be put away", () => {
		const start = gettingStarted([], [], []);
		expect(start.steps.map((step) => step.title)).toEqual([
			"Make a repository",
			"Connect an agent",
			"Give it a task",
			"See it land",
		]);
		expect(ticks(start)).toEqual([false, false, false, false]);
		expect(start.next).toBe("repo");
		expect(start.dismissable).toBe(false);
		expect(start.done).toBe(0);
	});

	it("ticks a repository of your own, not someone else's public one", () => {
		expect(ticks(gettingStarted([row("oss/lib", { public: true })], [], []))[0]).toBe(false);
		const start = gettingStarted([row("robin/notes")], [], []);
		expect(ticks(start)[0]).toBe(true);
		expect(start.next).toBe("agent");
	});

	it("ticks an agent once an app signs in as it, or one of its tokens has been used; not just for making one", () => {
		expect(ticks(gettingStarted([row("robin/notes")], [agent()], []))[1]).toBe(false);
		expect(ticks(gettingStarted([row("robin/notes")], [agent()], [app]))[1]).toBe(true);
		const used = agent({
			tokens: [
				{
					id: "t1",
					agentId: "a1",
					prefix: "x",
					createdAt: ago(60),
					expiresAt: null,
					lastUsedAt: ago(5),
					revokedAt: null,
				},
			],
		});
		expect(ticks(gettingStarted([row("robin/notes")], [used], []))[1]).toBe(true);
	});

	it("ticks a task at a repo's first claim, and the landing at its first merge, which a task came before", () => {
		const claimed = gettingStarted([row("robin/notes", { open: 1 })], [], [app]);
		expect(ticks(claimed)).toEqual([true, true, true, false]);
		expect(claimed.next).toBe("land");
		const landed = gettingStarted([row("robin/notes", { merged: 1 })], [], [app]);
		expect(ticks(landed)).toEqual([true, true, true, true]);
		expect(landed.next).toBeNull();
		expect(landed.done).toBe(4);
	});

	it("can be put away once something has landed, whatever else is left", () => {
		const theirs = gettingStarted([row("acme/site", { merged: 3 })], [], []);
		expect(ticks(theirs)[1]).toBe(false);
		expect(theirs.dismissable).toBe(true);
	});

	it("links each step to where it's done: the new repository form, Your agents, and the repo at work", () => {
		const start = gettingStarted([row("robin/notes"), row("robin/site", { open: 2 })], [], []);
		expect(start.steps.map((step) => step.href)).toEqual([
			"#/new",
			"#/settings/agents",
			"#/settings/agents",
			"#/repos/robin/site",
		]);
		expect(gettingStarted([], [], []).steps[3]!.href).toBeNull();
	});
});
