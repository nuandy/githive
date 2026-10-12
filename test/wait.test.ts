import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import type { Doorbell } from "../src/toolkit/tools/context";
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
			if (rings > mark) return rings;
			return new Promise((resolve) => {
				const done = (answer: number | null) => {
					clearTimeout(giveUp);
					listening.delete(done);
					resolve(answer);
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

const setUp = async () => {
	const bell = memoryDoorbell();
	const tools = toolCalls(() => server, { doorbell: () => bell, ping: async () => bell.ring() });
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

	it("holds at most 45 seconds", async () => {
		const { call } = await setUp();
		const refused = await call("wait", { agent: "reviewer", seconds: 46 }, "reviewer").catch(
			(err) => statusOf(err).message,
		);
		expect(refused).toBe("seconds is a whole number from 1 to 45");
	});
});
