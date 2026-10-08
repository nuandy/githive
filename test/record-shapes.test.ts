import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORD_FORMAT } from "../src/record-format";
import { GitCasLog } from "../src/record-log";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { joinLine, landedFromLine, type Line, lineRef, markPassed } from "../src/toolkit/line";
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
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]));
	return value === null ? "null" : typeof value;
}
function union(a: Shape, b: Shape): Shape {
	if (typeof a === "object" && !Array.isArray(a) && typeof b === "object" && !Array.isArray(b)) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		return Object.fromEntries(keys.map((k) => [k, k in a && k in b ? union(a[k], b[k]) : (a[k] ?? b[k])]));
	}
	return a;
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
	});
	const call = (agent: string, name: string, args: Record<string, unknown>) => callTool(name, { repo: "p", ...args }, ctx(agent));
	// Every kind of record and every optional field the toolkit writes today.
	await call("ada/lead", "start", { required: 1, vetoes: ["security"], grants: { security: ["@acme/security"] }, escalate: [{ paths: ["infra/"], required: 2 }], verify: ["npm test"], shard_depth: 0 });
	await callTool("register", { repo: "p", agent: "keyed-agent" }, { remote: async () => ({ url: server.url, token: "unused" }), head: async () => server.git("rev-parse", "main").trim() });
	await call("ada/builder", "claim", { change: "stats-1", paths: ["src/stats/"], intent: "Add stats" });
	await call("ada/builder", "claim", { change: "docs-1", paths: ["docs/"], intent: "Write docs" });
	await call("bob/reviewer", "vote", { commit: "1".repeat(40), role: "security", verdict: "approve", evidence: "ran the tests" });
	await call("ada/builder", "ask_human", { change: "stats-1", reason: "Which chart library?" });
	await call("ada/lead", "add_work", { title: "Add charts", intent: "Charts for stats", paths: ["src/charts/"] });
	await call("ada/builder", "release", { change: "docs-1", reason: "done elsewhere" });
	// The line of merges: one merge landed (with its commit), one passed and waiting, one still checking.
	const line = new GitCasLog<Line>(async () => ({ url: server.url, token: "unused" }), "p", lineRef("p"));
	const main = server.git("rev-parse", "main").trim();
	const first = await joinLine(line, { change: "stats-1", head: "1".repeat(40), agent: "ada/builder", main: async () => main });
	const second = await joinLine(line, { change: "docs-2", head: "2".repeat(40), agent: "ada/builder", main: async () => main });
	await joinLine(line, { change: "charts-3", head: "3".repeat(40), agent: "ada/builder", main: async () => main });
	if (first === "full" || second === "full") throw new Error("the line was full");
	await markPassed(line, second.id);
	await landedFromLine(line, first.id, "4".repeat(40));
	const read = async (ref: string) => (await new GitCasLog<unknown>(async () => ({ url: server.url, token: "unused" }), "p", ref).read())?.commit.state;
	shapes = {
		claims: shapeOf(await read("refs/notes/githive-claims/p")),
		votes: shapeOf(await read("refs/notes/githive-votes/p")),
		work: shapeOf(await read("refs/notes/githive-work/p")),
		line: shapeOf(await read(lineRef("p"))),
	};
}, 60_000);

afterAll(async () => {
	await server?.close();
});

describe("the shape of GitHive's records", () => {
	it(`is what format ${RECORD_FORMAT} says it is: a change needs a new format and an upgrade`, () => {
		const pinned = { format: RECORD_FORMAT, shapes };
		if (process.env.UPDATE_RECORD_SHAPES || !existsSync(FIXTURE)) writeFileSync(FIXTURE, `${JSON.stringify(pinned, null, "\t")}\n`);
		const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
		expect(
			pinned,
			"A record's shape changed. Records already in repos keep the old shape: bump RECORD_FORMAT in src/record-format.ts, add an upgrade from the old format, then run with UPDATE_RECORD_SHAPES=1.",
		).toEqual(fixture);
	});
});
