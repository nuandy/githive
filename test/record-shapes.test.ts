import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORD_FORMAT } from "../src/record-format";
import type { GitHubLink } from "../src/github";
import { GitCasLog } from "../src/record-log";
import { type GitHubImports, importsRef, recordImport } from "../src/toolkit/github-imports";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { holdReview, type ReviewHolds, reviewsRef, roleWaits, roleWaitTold } from "../src/toolkit/review-holds";
import { memoryLanding } from "../src/toolkit/landing";
import { gitLanding, landingRef, type LeaseRecord } from "../src/toolkit/landing-lease";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The shape of every kind of record GitHive keeps, pinned. Records outlive
// the code that wrote them: a change to their shape needs a new record format
// and an upgrade for the old one (see src/record-format.ts), or repos written
// before it would be misread. Run with UPDATE_RECORD_SHAPES=1 to write the
// fixture after doing that.

const FIXTURE = join(import.meta.dirname, "fixtures", "record-shapes.json");

type Shape = string | Shape[] | { [key: string]: Shape };

/** A value's shape: its keys and the types under them, arrays as the union of their items' shapes. */
function shapeOf(value: unknown): Shape {
	if (Array.isArray(value)) return value.length ? [value.map(shapeOf).reduce(union)] : [];
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]),
		);
	return value === null ? "null" : typeof value;
}
function union(a: Shape, b: Shape): Shape {
	if (typeof a === "object" && !Array.isArray(a) && typeof b === "object" && !Array.isArray(b)) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		return Object.fromEntries(keys.map((key) => [key, unionAt(a, b, key)]));
	}
	return a;
}
/** The shape under `key` in either object, joined when both have one. */
function unionAt(a: { [key: string]: Shape }, b: { [key: string]: Shape }, key: string): Shape {
	const left = a[key];
	const right = b[key];
	if (left === undefined) return right!;
	if (right === undefined) return left;
	return union(left, right);
}

let server: GitServer;
let shapes: Record<string, Shape>;

beforeAll(async () => {
	server = await startGitServer();
	const { privateKey } = await generateStampKey();
	const ctx = (agent: string): ToolContext => ({
		remote: async () => ({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		stamper: (acting?: string) => makeStamper(privateKey, `person:000000000000${acting ? `/${acting}` : ""}`),
		agent,
		teamsOf: async () => ["@acme/security"],
		github: async (repo: string) => ({ repo }) as GitHubLink,
	});
	const call = (agent: string, name: string, args: Record<string, unknown>) =>
		callTool(name, { repo: "p", ...args }, ctx(agent));
	// Every kind of record and every optional field the toolkit writes today.
	await call("ada/lead", "settings", {
		required: 1,
		vetoes: ["security"],
		grants: { security: ["@acme/security"] },
		escalate: [{ paths: ["infra/"], required: 2 }],
		verify: ["npm test"],
		shard_depth: 0,
	});
	// A GitHub link, with its mode and trust.
	await call("ada/lead", "settings", { github: "acme/shop", github_sync: "pr", github_trust: true });
	await callTool(
		"register",
		{ repo: "p", agent: "keyed-agent" },
		{
			remote: async () => ({ url: server.url, token: "unused" }),
			head: async () => server.git("rev-parse", "main").trim(),
		},
	);
	await call("ada/builder", "claim", { change: "stats-1", paths: ["src/stats/"], intent: "Add stats" });
	await call("ada/builder", "claim", { change: "docs-1", paths: ["docs/"], intent: "Write docs" });
	await call("bob/reviewer", "vote", {
		commit: "1".repeat(40),
		role: "security",
		verdict: "approve",
		evidence: "ran the tests",
	});
	await call("ada/builder", "ask_human", { change: "stats-1", reason: "Which chart library?" });
	await call("ada/lead", "add_work", { title: "Add charts", intent: "Charts for stats", paths: ["src/charts/"] });
	await call("ada/builder", "release", { change: "docs-1", reason: "done elsewhere" });
	// Review holds: one held, and a role's review waiting, told to people.
	const holds = new GitCasLog<ReviewHolds>(async () => ({ url: server.url, token: "unused" }), "p", reviewsRef("p"));
	await holdReview(holds, `${"1".repeat(40)}#review`, "bob/reviewer", 1);
	await roleWaits(holds, [`${"1".repeat(40)}#security`]);
	await roleWaitTold(holds, `${"1".repeat(40)}#security`);
	// A branch's landing lease, held, with the batch its holder is checking.
	const lease = gitLanding(
		new GitCasLog<LeaseRecord>(async () => ({ url: server.url, token: "unused" }), "p", landingRef("p", "main")),
		memoryLanding(),
	);
	await lease.turn("merge-1", "stats-1", "1".repeat(40), 0, 60_000);
	await lease.checking({
		base: "2".repeat(40),
		since: new Date().toISOString(),
		changes: [{ change: "stats-1", head: "1".repeat(40), agent: "ada/builder" }],
	});
	// GitHub's commit brought in, as githive-github's job records it.
	await recordImport(
		new GitCasLog<GitHubImports>(async () => ({ url: server.url, token: "unused" }), "p", importsRef("p")),
		{ github: "acme/shop", branch: "main", commit: "3".repeat(40), head: "4".repeat(40), base: "2".repeat(40) },
		await makeStamper(privateKey, "service:githive-github"),
	);
	const read = async (ref: string) =>
		(await new GitCasLog<unknown>(async () => ({ url: server.url, token: "unused" }), "p", ref).read())?.commit.state;
	shapes = {
		claims: shapeOf(await read("refs/notes/githive-claims/p")),
		votes: shapeOf(await read("refs/notes/githive-votes/p")),
		work: shapeOf(await read("refs/notes/githive-work/p")),
		reviews: shapeOf(await read(reviewsRef("p"))),
		landing: shapeOf(await read(landingRef("p", "main"))),
		github: shapeOf(await read(importsRef("p"))),
	};
}, 60_000);

afterAll(async () => {
	await server?.close();
});

describe("the shape of GitHive's records", () => {
	it(`is what format ${RECORD_FORMAT} says it is: a change needs a new format and an upgrade`, () => {
		const pinned = { format: RECORD_FORMAT, shapes };
		if (process.env.UPDATE_RECORD_SHAPES || !existsSync(FIXTURE))
			writeFileSync(FIXTURE, `${JSON.stringify(pinned, null, "\t")}\n`);
		const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
		expect(
			pinned,
			"A record's shape changed. Records already in repos keep the old shape: bump RECORD_FORMAT in " +
				"src/record-format.ts, add an upgrade from the old format, then run with " +
				"UPDATE_RECORD_SHAPES=1.",
		).toEqual(fixture);
	});
});
