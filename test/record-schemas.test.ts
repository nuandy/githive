import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import { checkedState } from "../src/record-schemas";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Records live in Git, where anyone with the account's credentials can write one with plain git. A malformed state
// fails as a clear error naming the record, while records with fields this GitHive doesn't know still read.

const claimsRef = "refs/notes/githive-claims/p";

describe("a record's state, checked as it's read", () => {
	it("passes a well-formed state, extra fields and all", () => {
		const state = {
			claims: [{ change: "a-1", agent: "ada", paths: ["src/a/"], intent: "a", since: "2026-10-10T00:00:00.000Z" }],
			released: [],
			addedLater: { anything: true },
		};
		expect(checkedState(claimsRef, state)).toBe(state);
		const votes = { votes: [{ commit: "c".repeat(40), reviewer: "bob", role: "review", verdict: "approve" }] };
		expect(checkedState("refs/notes/githive-votes/p", votes)).toBe(votes);
		const lease = { checking: null };
		expect(checkedState("refs/notes/githive-landing/p/main", lease)).toBe(lease);
	});

	it("refuses a malformed one, naming the record and what's wrong", () => {
		expect(() => checkedState(claimsRef, { claims: "nope", released: [] })).toThrow(
			/^\[500\] the record at refs\/notes\/githive-claims\/p is malformed \(claims: /,
		);
		const badPath = { claims: [{ change: "a-1", agent: "ada", paths: [7] }], released: [] };
		expect(() => checkedState(claimsRef, badPath)).toThrow(/\(claims\.0\.paths\.0: /);
		const badVerdict = { votes: [{ commit: "c", reviewer: "bob", role: "review", verdict: "maybe" }] };
		expect(() => checkedState("refs/notes/githive-vote-buckets/p/3", badVerdict)).toThrow(/votes\.0\.verdict/);
		expect(() => checkedState(claimsRef, null)).toThrow(/malformed \(its state: /);
	});

	it("passes a record of no known kind as it is", () => {
		expect(checkedState("refs/notes/someone-else/p", 42)).toBe(42);
	});
});

describe("a malformed record in Git", { timeout: 60_000 }, () => {
	let server: GitServer;
	beforeAll(async () => {
		server = await startGitServer();
	});
	afterAll(async () => {
		await server?.close();
	});

	it("fails to read with that error, not an undefined property somewhere later", async () => {
		const log = new GitCasLog<unknown>(async () => ({ url: server.url, token: "unused" }), "p", claimsRef);
		const commit = { author: "eve", kind: "decisions", entries: [], state: { claims: { not: "a list" } }, batch: "b" };
		expect(await log.append(null, commit)).toBeTruthy();
		await expect(log.read()).rejects.toThrow(/the record at refs\/notes\/githive-claims\/p is malformed \(claims: /);
	});
});
