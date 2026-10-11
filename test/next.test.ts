import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS } from "../src/toolkit/mcp";
import { rejectedFor } from "../src/toolkit/merge-checks";
import { nextFor } from "../src/toolkit/tools/next";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// Every reply about an agent's own work says what follows for it, in `next`, worked out from that reply alone. It never
// picks work from the crowd: no piece of the backlog, no review, no change another agent holds is named as work to do.

const HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const LANDED = "2f56723d0a1b2c3d4e5f60718293a4b5c6d7e8f9";

// [tool, args, reply, the next step]: one reply of each kind each tool gives where a next step is clear.
const CARRIES_NEXT: [string, Record<string, unknown>, Record<string, unknown>, string | RegExp][] = [
	[
		"claim",
		{ change: "c-1" },
		{ ok: true },
		"Call `credentials` with change c-1, build on `changes/c-1` in your clone, push to `fork`, then call `status`.",
	],
	["claim", { change: "c-1" }, { ok: true, source: "feature/f", head: HEAD }, /already feature\/f's tip/],
	["claim", { change: "c-1" }, { ok: false, conflicts: [] }, "Pick other work from `backlog`, or claim again later."],
	["build", {}, { change: "stats-ab12", builder: "fork--p--stats-ab12" }, /builder makes stats-ab12.*`status`/],
	["release", { change: "c-1" }, { ok: true }, "Released. Choose other work from `backlog`."],
	["release", { change: "o-1", stale: true }, { ok: true }, "Released as abandoned: claim the paths you need."],
	[
		"credentials",
		{ change: "c-1" },
		{ url: "u", token: "t", branch: "changes/c-1", git: { setup: [], push: "" } },
		"Clone (the `git` setup commands), build on `changes/c-1`, push to `fork`, then call `status`.",
	],
	[
		"credentials",
		{ change: "o-1" },
		{ change: "o-1", author: "other", head: HEAD, role: "security" },
		`Run the \`git\` setup commands, read the diff, then \`vote\` on ${HEAD} as security, with what you checked as evidence.`,
	],
	[
		"status",
		{ change: "c-1" },
		{ change: "c-1", claim: { agent: "a" }, head: null },
		/^Nothing pushed yet: build on `changes\/c-1`/,
	],
	[
		"status",
		{ change: "c-1" },
		{
			change: "c-1",
			claim: { agent: "a" },
			head: HEAD,
			votes: [],
			approval: { approved: false, approvals: 0, required: 2, awaiting: ["security"], vetoedBy: [] },
			merge: { into: "main", clean: true, outsideClaim: [] },
		},
		"Waiting for 2 more approvals (including security, which can veto it); agents who may give them see it in `reviews`.",
	],
	[
		"status",
		{ change: "c-1" },
		{
			change: "c-1",
			claim: { agent: "a" },
			head: HEAD,
			votes: [],
			approval: { approved: true, approvals: 1, required: 1, awaiting: [], vetoedBy: [] },
			merge: { into: "main", clean: true, outsideClaim: [] },
		},
		"Call `merge`.",
	],
	[
		"status",
		{ change: "c-1" },
		{
			change: "c-1",
			claim: { agent: "a" },
			head: HEAD,
			votes: [{ commit: HEAD, reviewer: "r", verdict: "reject", evidence: "breaks rounding" }],
			approval: { approved: false, approvals: 0, required: 1, awaiting: [], vetoedBy: [] },
			merge: { into: "main", clean: true, outsideClaim: [] },
		},
		"Changes were asked for: address the rejection's evidence, push a new commit to `fork`, then call `status`.",
	],
	[
		"status",
		{ change: "c-1" },
		{
			change: "c-1",
			claim: { agent: "a" },
			head: HEAD,
			votes: [
				{
					commit: HEAD,
					reviewer: "githive-checks",
					verdict: "reject",
					evidence: "checks failed: npm test exited 1 on 4b825dc6, checked alone on the branch, twice:\nFAIL",
				},
			],
			approval: { approved: false, approvals: 0, required: 0, awaiting: [], vetoedBy: [] },
			merge: { into: "main", clean: true, outsideClaim: [] },
		},
		/^Its checks failed: `npm test` exited 1\. Reproduce it in your clone/,
	],
	[
		"status",
		{ change: "c-1" },
		{
			change: "c-1",
			claim: { agent: "a" },
			head: HEAD,
			votes: [],
			approval: { approved: true, approvals: 1, required: 1, awaiting: [], vetoedBy: [] },
			merge: { into: "main", clean: false, conflicts: ["src/a.ts"], outsideClaim: ["docs/x.md"] },
		},
		"It conflicts with main in src/a.ts: merge main into your branch (git fetch origin main && git merge origin/main), " +
			"resolve inside your claim so both changes make sense, push `changes/c-1` to `fork`, then call `status`.\n" +
			"docs/x.md is outside your claim: claim them too (`claim` c-1 again with the extra paths), or move them out of " +
			"this change.",
	],
	[
		"status",
		{ change: "c-1" },
		{
			change: "c-1",
			claim: { agent: "a" },
			head: HEAD,
			votes: [],
			approval: { approved: true, approvals: 1, required: 1, awaiting: [], vetoedBy: [] },
			// The commands that resolve it in the agent's clone, when the status has them.
			merge: {
				into: "main",
				clean: false,
				conflicts: ["src/a.ts"],
				fix: ["git fetch origin main && git merge origin/main", "call status"],
			},
		},
		"It conflicts with main in src/a.ts. In your clone:\ngit fetch origin main && git merge origin/main\ncall status",
	],
	[
		"status",
		{ change: "c-1" },
		{ change: "c-1", claim: { agent: "a" }, head: HEAD, waitsOn: ["waits on api, which hasn't merged yet"] },
		/^It waits on what it depends on/,
	],
	[
		"status",
		{ change: "c-1" },
		{ change: "c-1", claim: { agent: "a" }, head: HEAD, landed: { commit: LANDED, at: "" } },
		"Landed as 2f56723d: don't merge it again. Choose your next work from `backlog` or `reviews`.",
	],
	[
		"status",
		{ change: "c-1" },
		{ change: "c-1", claim: null, released: { agent: "a", reason: "merged", mergedAs: LANDED }, head: HEAD },
		"Merged as 2f56723d. Choose your next work from `backlog` or `reviews`.",
	],
	[
		"merge",
		{ change: "c-1", agent: "a" },
		{ ok: true, commit: LANDED },
		"Landed as 2f56723d; your claim is released. Choose your next work from `backlog` or `reviews`.",
	],
	[
		"merge",
		{ change: "c-1", agent: "a" },
		{ ok: false, pending: true, reasons: ["c-1 is ready and waiting to land"] },
		"Call `merge` again; it lands with the next batch.",
	],
	[
		"merge",
		{ change: "c-1", agent: "a" },
		{
			ok: false,
			why: ["conflict"],
			into: "main",
			conflicts: ["src/a.ts"],
			reasons: ["changes/c-1 conflicts with main in src/a.ts (last changed by o-7, bob): merge main into your branch"],
		},
		/^It conflicts with main in src\/a\.ts: merge main into your branch \(git fetch origin main && git merge origin\/main\)/,
	],
	[
		"merge",
		{ change: "c-1", agent: "a" },
		{
			ok: false,
			why: ["checks"],
			reasons: ["checks failed: npm test exited 1"],
			checks: [{ command: "npm test", exitCode: 1, output: "FAIL" }],
		},
		/^Its checks failed: `npm test` exited 1\. Reproduce it in your clone/,
	],
	[
		"merge",
		{ change: "c-1", agent: "a" },
		{ ok: false, why: ["approvals"], reasons: [`${HEAD} has 0 of 1 approvals from reviewers other than its author`] },
		/^Waiting for approvals: `status` shows how many/,
	],
	[
		"merge",
		{ change: "c-1", agent: "a" },
		{
			ok: false,
			why: ["outside", "inside"],
			outsideClaim: ["src/b.ts"],
			insideOthers: ["src/o.ts"],
			reasons: ["src/b.ts is outside c-1's claim", "src/o.ts is inside o-2's claim (other)"],
		},
		"src/b.ts is outside your claim: claim them too (`claim` c-1 again with the extra paths), or move them out of " +
			"this change.\nsrc/o.ts is inside others' claims: move them out of this change, or wait until those claims " +
			"are released (`claims` shows whose).",
	],
	["vote", {}, { ok: true, tip: HEAD }, "Done. Choose more from `reviews`."],
	[
		"request_review",
		{ change: "c-1" },
		{ head: HEAD, reviewers: ["review", "security"] },
		"GitHive's reviewers (review and security) review 4b825dc6 and vote: call `status` to see their votes.",
	],
	["ask_human", { change: "c-1" }, { ok: true, tip: HEAD }, /^A person decides with their own vote/],
];

// The tools with no next step of the caller's own: they set things up, are about the whole repo, or are lists to choose
// from, which next never chooses from.
const NO_NEXT: [string, Record<string, unknown>, unknown][] = [
	["settings", {}, { repo: "p", policy: { required: 0, vetoes: [] }, verify: [] }],
	["claims", {}, [{ change: "o-1", agent: "other", paths: ["src/"] }]],
	["add_work", {}, { ok: true, id: "free-piece" }],
	["reviews", { agent: "a" }, { reviews: [{ change: "o-1", head: HEAD }] }],
	["backlog", { agent: "a" }, { open: [{ id: "free-piece" }], waiting: [] }],
	["audit", {}, { merges: 0, open: 0, violations: [] }],
	["revert", {}, { ok: true }],
	["register", { agent: "a" }, { agent: "a", key: "a.secret", note: "" }],
];

describe("next", () => {
	it("every object reply carries next", () => {
		for (const [tool, args, reply, step] of CARRIES_NEXT)
			if (typeof step === "string") expect(nextFor(tool, args, reply), tool).toBe(step);
			else expect(nextFor(tool, args, reply), tool).toMatch(step);
		for (const [tool, args, reply] of NO_NEXT) expect(nextFor(tool, args, reply), tool).toBeUndefined();
		// Every tool is one or the other, so a new tool is decided on, not forgotten.
		const decided = new Set([...CARRIES_NEXT, ...NO_NEXT].map(([tool]) => tool));
		expect(TOOLS.map((tool) => tool.name).filter((tool) => !decided.has(tool))).toEqual([]);
		// Read-only access to the project, with no change, has no step of its own.
		expect(nextFor("credentials", {}, { url: "u", token: "t", note: "read-only" })).toBeUndefined();
	});

	it("is the change's agent's: another agent looking at it, or merging it, gets none", () => {
		const status = { change: "c-1", claim: { agent: "a" }, head: HEAD, approval: { approved: true } };
		expect(nextFor("status", { change: "c-1" }, status, "a")).toBe("Call `merge`.");
		expect(nextFor("status", { change: "c-1" }, status)).toBe("Call `merge`.");
		expect(nextFor("status", { change: "c-1" }, status, "b")).toBeUndefined();
		expect(nextFor("merge", { change: "c-1", agent: "a" }, { ok: true, commit: LANDED }, "b")).toBeUndefined();
	});

	it("follows a refused merge's why and fields, so rewording its reasons changes nothing", () => {
		const fix = [
			"git fetch origin main && git merge origin/main",
			"call status; once the new commit is approved, merge again",
		];
		const checks =
			"Its checks failed: `npm test` exited 1. Reproduce it in your clone, up to date with the branch it lands on; fix it, push a new commit to `fork`, then call `status`.";
		// [the refusal as each place that refuses makes it, its next]
		const refusals: [Record<string, unknown>, string][] = [
			// merge-ready.ts: its own test merge conflicts.
			[
				{
					why: ["conflict"],
					into: "main",
					conflicts: ["src/a.ts"],
					fix,
					reasons: ["changes/c-1 conflicts with main in src/a.ts"],
				},
				`It conflicts with main in src/a.ts. In your clone:\n${fix.join("\n")}`,
			],
			// merge-land.ts: put out for a conflict found while landing.
			[
				{
					why: ["conflict"],
					into: "main",
					conflicts: ["src/a.ts"],
					touchedBy: [{ file: "src/a.ts", commit: LANDED, change: "o-7", agent: "bob" }],
					fix,
					reasons: ["conflict on src/a.ts with o-7 by bob (2f56723)"],
				},
				`It conflicts with main in src/a.ts. In your clone:\n${fix.join("\n")}`,
			],
			// merge-ready.ts: the checks' rejection of a head that didn't merge, which names no files.
			[
				{ why: ["conflict"], into: "main", reasons: [`conflict on src/a.ts on ${HEAD.slice(0, 8)}: push a fix`] },
				"It conflicts with main: merge main into your branch (git fetch origin main && git merge origin/main), " +
					"resolve inside your claim so both changes make sense, push `changes/c-1` to `fork`, then call `status`.",
			],
			// merge-checks.ts: put out for failed checks; merge-ready.ts: their rejection of this head, read back.
			[
				{
					why: ["checks"],
					checks: [{ command: "npm test", exitCode: 1, output: "FAIL" }],
					reasons: ["checks failed: npm test exited 1"],
				},
				checks,
			],
			[
				{ why: ["unclaimed", "approvals"], reasons: ["c-1 holds no claim", `${HEAD} has 0 of 1 approvals`] },
				"Claim c-1 again (`claim`), then call `merge`.\nWaiting for approvals: `status` shows how many and as what; " +
					"agents who may give them see it in `reviews`.",
			],
			[
				{ why: ["changes-asked"], reasons: [`${HEAD} is vetoed by sec (security)`] },
				"Changes were asked for: address the rejection's evidence, push a new commit to `fork`, then call `status`.",
			],
			// merge-tools.ts: it waits on a change it depends on.
			[
				{ why: ["after"], reasons: ["waits on api, which hasn't merged yet"] },
				"It waits on what it depends on (see reasons): call `merge` again once that has merged.",
			],
			// merge-batch.ts: the branch kept moving, or the change couldn't be read.
			[{ why: ["moved"], reasons: ["the project's branch kept moving while c-1 merged"] }, "Call `merge` again."],
			[
				{ why: ["unread"], reasons: ["c-1 couldn't be read: no such ref"] },
				"Call `merge` again; if it still can't be read, push `changes/c-1` to `fork` again.",
			],
		];
		const args = { change: "c-1", agent: "a" };
		for (const [refusal, step] of refusals) {
			const reply = { ok: false, ...refusal };
			expect(nextFor("merge", args, reply)).toBe(step);
			expect(nextFor("merge", args, { ...reply, reasons: ["in other words, entirely"] })).toBe(step);
			expect(nextFor("merge", args, { ...reply, reasons: [] })).toBe(step);
		}
		// The repo's setup is for the people who run it.
		const setup = {
			ok: false,
			why: ["setup"],
			reasons: ["checks run on GitHub Actions, but no GitHub repo is connected"],
		};
		expect(nextFor("merge", args, setup)).toBeUndefined();
		// A refusal without why is read from its fields.
		expect(nextFor("merge", args, { ok: false, conflicts: ["src/a.ts"], into: "main", reasons: [] })).toMatch(
			/^It conflicts with main in src\/a\.ts: merge main into your branch/,
		);
	});

	it("is bounded, however many files or holders a reply names", () => {
		const files = Array.from({ length: 300 }, (_, index) => `src/very/long/path/to/a/file-${index}.ts`);
		const merge = { into: "main", clean: false, conflicts: files, fix: files.map((file) => `git add ${file}`) };
		const next = nextFor("status", {}, { change: "c-1", claim: { agent: "a" }, head: HEAD, merge })!;
		expect(next.length).toBeLessThan(2_100);
		expect(next).toContain("src/very/long/path/to/a/file-4.ts and 295 more");
		expect(next).toMatch(/\(cut: the reply has the rest\)$/);
	});

	it("reads a rejection written before conflicts had words of their own as a conflict, not failed checks", () => {
		const evidence =
			"checks failed: (merging the batch onto main) exited 1 on 4b825dc6, checked alone on the branch, twice:\n" +
			"conflict on src/a.ts";
		expect(rejectedFor(evidence)).toEqual({ why: "conflict" });
		const status = {
			change: "c-1",
			claim: { agent: "a" },
			head: HEAD,
			votes: [{ commit: HEAD, reviewer: "githive-checks", verdict: "reject", evidence }],
			approval: { approved: false, approvals: 0, required: 1, awaiting: [], vetoedBy: [] },
			merge: { into: "main", clean: false, conflicts: ["src/a.ts"], outsideClaim: [] },
		};
		expect(nextFor("status", { change: "c-1" }, status)).toMatch(/^It conflicts with main in src\/a\.ts/);
		expect(nextFor("status", { change: "c-1" }, status)).not.toMatch(/checks failed/);
	});
});

describe("next through the tools", { timeout: 120_000 }, () => {
	let server: GitServer;
	let work: string;
	// News of a landing is in every object reply; next must not take work from it either.
	const news = async () => [
		{
			kind: "landed" as const,
			change: "news-change",
			agent: "z",
			at: new Date().toISOString(),
			commit: LANDED,
			files: ["x"],
		},
	];
	const { call, register } = toolCalls(() => server, { news });
	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-next-"));
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	it("a refused claim's next names the holder and the options", async () => {
		await call("settings", {});
		await register("a", "b");
		await call(
			"claim",
			{ change: "b-1", agent: "b", paths: ["src/auth/"], intent: "Fix the login loop\nin detail" },
			"b",
		);
		const refused = await call(
			"claim",
			{ change: "a-1", agent: "a", paths: ["src/auth/login.ts", "src/auth/x.ts"], intent: "Rate-limit logins" },
			"a",
		);
		expect(refused).toMatchObject({ ok: false, conflicts: [{ change: "b-1", agent: "b" }, { change: "b-1" }] });
		expect(refused.next).toBe(
			'Held by b\'s b-1 ("Fix the login loop"). Pick other work from `backlog`, or claim again later.',
		);
		// Several holders are each named once, at most three of them.
		const many = nextFor(
			"claim",
			{ change: "a-1" },
			{
				ok: false,
				conflicts: ["h-1", "h-2", "h-3", "h-4", "h-2"].map((change) => ({ change, agent: "x", intent: "i" })),
			},
		);
		expect(many).toBe(
			'Held by x\'s h-1 ("i"), x\'s h-2 ("i"), x\'s h-3 ("i") and 1 more. Pick other work from `backlog`, or claim ' +
				"again later.",
		);
	});

	it("next never names another agent's change to work on", async () => {
		await call("settings", { required: 1, vetoes: [] });
		await register("a", "b", "reviewer");
		const others = ["free-piece", "b-piece", "news-change"];
		await call(
			"add_work",
			{ title: "free piece", id: "free-piece", intent: "x", paths: ["src/free/"], agent: "b" },
			"b",
		);
		await call("add_work", { title: "b piece", id: "b-piece", intent: "y", paths: ["src/b/"], agent: "b" }, "b");
		await call("claim", { change: "b-piece", agent: "b", paths: ["src/b/"], intent: "y" }, "b");
		const bHead = await pushChange(server.url, work, "b", "b-piece", { "src/b/index.js": "b\n" });

		// Everything a says to GitHive while it works on a-1 and reviews b's change, and what follows each reply.
		const steps: [string, unknown][] = [];
		const as = async (tool: string, args: Record<string, unknown>) => {
			const reply = await call(tool, args, "a");
			steps.push([tool, Array.isArray(reply) ? "a list" : reply.next]);
			return reply;
		};
		expect(await as("backlog", { agent: "a" })).toMatchObject({ open: [{ id: "free-piece" }] });
		expect(await as("reviews", { agent: "a" })).toMatchObject({ reviews: [{ change: "b-piece" }] });
		await as("claims", {});
		await as("claim", { change: "a-1", agent: "a", paths: ["src/a/"], intent: "a" });
		await as("credentials", { change: "a-1" });
		await as("status", { change: "a-1" });
		await pushChange(server.url, work, "a", "a-1", { "src/a/index.js": "a\n" });
		await as("status", { change: "a-1" });
		await as("credentials", { change: "b-piece" });
		await as("vote", { commit: bHead, reviewer: "a", role: "review", verdict: "approve", evidence: "ran it" });
		await as("status", { change: "b-piece" });
		await as("merge", { change: "a-1", agent: "a" });

		expect(steps).toEqual([
			["backlog", undefined],
			["reviews", undefined],
			["claims", "a list"],
			["claim", expect.stringMatching(/^Call `credentials` with change a-1/)],
			["credentials", expect.stringMatching(/^Clone/)],
			["status", expect.stringMatching(/^Nothing pushed yet/)],
			["status", expect.stringMatching(/^Waiting for 1 more approval;/)],
			["credentials", expect.stringMatching(new RegExp(`vote\` on ${bHead}`))],
			["vote", "Done. Choose more from `reviews`."],
			// b's change is b's to merge: a hears nothing of it.
			["status", undefined],
			["merge", expect.stringMatching(/^Waiting for approvals/)],
		]);
		for (const [tool, next] of steps) for (const other of others) expect(String(next ?? ""), tool).not.toContain(other);
		// b, whose change it is, hears that it may merge.
		expect((await call("status", { change: "b-piece" }, "b")).next).toBe("Call `merge`.");
	});

	it("says how to bring main in when the change conflicts with it", async () => {
		await call("settings", {});
		await register("a");
		await call("claim", { change: "a-1", agent: "a", paths: ["src/a/"], intent: "a" }, "a");
		await pushChange(server.url, work, "a", "a-1", { "src/a/x.js": "mine\n" });
		// Someone pushes to main directly, changing the same file.
		const rogue = await agentClone(server.url, work, "rogue");
		rogue.write("src/a/x.js", "theirs\n");
		await rogue.run("add", "-A");
		await rogue.run("commit", "--quiet", "-m", "theirs");
		await rogue.run("push", "--quiet", "origin", "main");
		const status = await call("status", { change: "a-1" }, "a");
		expect(status).toMatchObject({ merge: { clean: false, conflicts: ["src/a/x.js"] } });
		expect(status.next).toMatch(/^It conflicts with main in src\/a\/x\.js/);
		expect(status.next).toMatch(/so both changes make sense/);
	});
});
