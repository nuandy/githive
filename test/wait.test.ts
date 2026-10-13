import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import type { Doorbell, ToolContext } from "../src/toolkit/tools/context";
import { FakeStorage } from "./fakes/env";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// wait holds an outside agent's call until something that concerns it changes: its own change, the reviews it may
// give or the backlog free to it. It looks again only when the repo's doorbell rings, and a write that changes none
// of those keeps it holding.

/** A doorbell like RepoCache's, rung by every write the tools ping. */
function memoryDoorbell(): Doorbell & { ring(): void } {
	let rings = 0;
	const listening = new Set<(rings: number) => void>();
	return {
		rings: async () => rings,
		ringAfter: async (mark, ms) => {
			if (rings > mark) return { rings, reasons: ["write"] };
			return new Promise((resolve) => {
				const done = (answer: number | null) => {
					clearTimeout(giveUp);
					listening.delete(done);
					resolve(answer === null ? null : { rings: answer, reasons: ["write"] });
				};
				const giveUp = setTimeout(() => done(null), ms);
				listening.add(done);
			});
		},
		ring: () => {
			rings += 1;
			for (const wake of [...listening]) wake(rings);
		},
	};
}

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-wait-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

const setUp = async (extra: Partial<ToolContext> = {}) => {
	const bell = memoryDoorbell();
	const tools = toolCalls(() => server, { doorbell: () => bell, ping: async () => bell.ring(), ...extra });
	await tools.call("settings", { required: 1 });
	await tools.register("author", "reviewer", "other");
	return { ...tools, bell };
};

describe("wait", { timeout: 60_000 }, () => {
	it("answers at once when something changed since the seen it's given, and says what", async () => {
		const { call } = await setUp();
		const quiet = await call("wait", { agent: "reviewer", seconds: 1 }, "reviewer");
		expect(quiet).toMatchObject({
			changed: false,
			reviews: 0,
			backlog: 0,
			next: expect.stringMatching(/`wait` again/),
		});
		await call("claim", { change: "c-1", agent: "author", paths: ["src/c/"], intent: "c" }, "author");
		await pushChange(server.url, work, "author", "c-1", { "src/c/x.js": "x\n" });
		const started = Date.now();
		const woken = await call("wait", { agent: "reviewer", seen: quiet.seen }, "reviewer");
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(woken).toMatchObject({ changed: true, what: ["reviews"], reviews: 1 });
		expect(woken.next).toMatch(/look with `reviews`/);
	});

	it("holds through a write that doesn't concern the caller, and wakes on a vote on its change", async () => {
		const { call, approve } = await setUp();
		await call("claim", { change: "c-1", agent: "author", paths: ["src/c/"], intent: "c" }, "author");
		const head = await pushChange(server.url, work, "author", "c-1", { "src/c/x.js": "x\n" });
		let settled = false;
		const waiting = call("wait", { agent: "author" }, "author").finally(() => (settled = true));
		// Another agent's claim, with nothing pushed: no review to give, nothing of the author's.
		await call("claim", { change: "o-1", agent: "other", paths: ["src/o/"], intent: "o" }, "other");
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(settled).toBe(false);
		await approve(head);
		expect(await waiting).toMatchObject({
			changed: true,
			what: ["yours"],
			yours: [{ change: "c-1", head, approvals: 1, rejections: 0 }],
		});
	});

	it("keeps the whole call within its seconds, looks included, however late the doorbell rings", async () => {
		// Each look takes at least 400 ms.
		const slowly = async () => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			return new Set<string>();
		};
		const { call, bell } = await setUp({ buildersAtWork: slowly });
		// Rings that change nothing for the caller, the last just before the end.
		const rings = [500, 1_000, 1_500, 1_900].map((ms) => setTimeout(() => bell.ring(), ms));
		const started = Date.now();
		const quiet = await call("wait", { agent: "reviewer", seconds: 2 }, "reviewer");
		rings.forEach(clearTimeout);
		expect(quiet).toMatchObject({ changed: false });
		// Without room left for the last look, the ring at 1.9 s would run the call past 2.3 s.
		expect(Date.now() - started).toBeLessThan(2_200);
	});

	it("holds at most 45 seconds", async () => {
		const { call } = await setUp();
		const refused = await call("wait", { agent: "reviewer", seconds: 46 }, "reviewer").catch(
			(err) => statusOf(err).message,
		);
		expect(refused).toBe("seconds is a whole number from 1 to 45");
	});
});

// A notice (a heads-up, interface news, a hint about a push) rings the repo and ends the hold of the agent it's for, and
// the reply's news carries it. Here the repo's own RepoCache is the doorbell, the news and the notices.
describe("wait and notices", { timeout: 60_000 }, () => {
	const notice = (says: string) => ({ kind: "heads_up", at: new Date().toISOString(), says, change: "c-1" });

	const setUpCache = async () => {
		const { RepoCache } = await import("../src/repo-cache");
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		// Each look asks for the newest notice once, so counting those counts the looks.
		const looks = { count: 0 };
		const doorbell: Doorbell = {
			rings: () => cache.rings(),
			ringAfter: (mark, ms, agent) => cache.ringAfter(mark, ms, agent),
			rungFor: (agent, mark) => cache.rungFor(agent, mark),
			newestNotice: (agent) => ((looks.count += 1), cache.newestNotice(agent)),
		};
		const tools = toolCalls(() => server, {
			doorbell: () => doorbell,
			news: (_repo, branch, agent) => cache.landingNews(branch, agent),
			ping: (_repo, event, tool, whom) => cache.ping("records", true, event ? [event] : [], tool, whom),
			keptClaims: (_repo, read) => read(),
		});
		await tools.call("settings", { required: 1 });
		await tools.register("author", "other");
		await tools.call("claim", { change: "c-1", agent: "author", paths: ["src/c/"], intent: "c" }, "author");
		return { ...tools, cache, looks };
	};

	it("ends the hold of the agent a notice is for, with the notice in the reply's news", async () => {
		const { call, cache } = await setUpCache();
		const quiet = await call("wait", { agent: "author", seconds: 1 }, "author");
		const started = Date.now();
		const held = call("wait", { agent: "author", seen: quiet.seen, seconds: 20 }, "author");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await cache.notify("main", [{ agent: "author", notice: notice("bob's change alters getUser, which c-1 uses") }]);
		const woken = await held;
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(woken).toMatchObject({ changed: true, what: ["notices"] });
		expect(woken.news).toEqual([expect.objectContaining({ says: "bob's change alters getUser, which c-1 uses" })]);
		expect(woken.next).toMatch(/^Something that concerns you changed: read the notices in this reply's `news`/);
		// Told once: the next wait with this seen holds, though the notice it saw is gone.
		expect(await call("wait", { agent: "author", seen: woken.seen, seconds: 1 }, "author")).toMatchObject({
			changed: false,
		});
	});

	it("holds through a notice for another agent, and catches one left between two calls", async () => {
		const { call, cache } = await setUpCache();
		const quiet = await call("wait", { agent: "author", seconds: 1 }, "author");
		const started = Date.now();
		const held = call("wait", { agent: "author", seen: quiet.seen, seconds: 3 }, "author");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await cache.notify("main", [{ agent: "other", notice: notice("for someone else") }]);
		expect(await held).toMatchObject({ changed: false });
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
		// Reading for seen leaves a notice where it is: the reply that returns is the one that tells it.
		await cache.notify("main", [{ agent: "author", notice: notice("left between two calls") }]);
		expect(await cache.newestNotice("author")).not.toBeNull();
		const caught = await call("wait", { agent: "author", seen: quiet.seen, seconds: 5 }, "author");
		expect(caught).toMatchObject({ changed: true, what: ["notices"] });
		expect(caught.news).toEqual([expect.objectContaining({ says: "left between two calls" })]);
	});

	it("holds with a seen, reading nothing, through writes for others, until one for its agent", async () => {
		const { call, cache, looks } = await setUpCache();
		const quiet = await call("wait", { agent: "author", seconds: 1 }, "author");
		looks.count = 0;
		const held = call("wait", { agent: "author", seen: quiet.seen, seconds: 20 }, "author");
		await new Promise((resolve) => setTimeout(resolve, 300));
		// Another agent's claim only takes work away, so it wakes no one waiting.
		await call("claim", { change: "o-1", agent: "other", paths: ["src/o/"], intent: "o" }, "other");
		await cache.notify("main", [{ agent: "other", notice: notice("for someone else") }]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(looks.count).toBe(0);
		await cache.notify("main", [{ agent: "author", notice: notice("for the author") }]);
		expect(await held).toMatchObject({ changed: true, what: ["notices"] });
		expect(looks.count).toBe(1);
		// Nothing rang for it since, so the next call holds without a look, and answers with the same seen.
		const woken = await held;
		looks.count = 0;
		const again = await call("wait", { agent: "author", seen: woken.seen, seconds: 1 }, "author");
		expect(again).toEqual(expect.objectContaining({ changed: false, seen: woken.seen }));
		expect(looks.count).toBe(0);
	});

	it("still compares a seen from before notices were part of it", async () => {
		const { call, cache } = await setUpCache();
		const quiet = await call("wait", { agent: "author", seconds: 1 }, "author");
		const older = String(quiet.seen).split(".").slice(0, 3).join(".");
		expect(await call("wait", { agent: "author", seen: older, seconds: 1 }, "author")).toMatchObject({
			changed: false,
		});
		await cache.notify("main", [{ agent: "author", notice: notice("a heads-up") }]);
		expect(await call("wait", { agent: "author", seen: older, seconds: 1 }, "author")).toMatchObject({
			changed: false,
		});
	});
});
