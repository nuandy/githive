import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import { claimStore } from "../src/toolkit/claim-store";
import type { Registry } from "../src/toolkit/claims";
import { giveBackPartClaim, withoutLeftovers } from "../src/toolkit/tools/claim-leftovers";
import type { ToolCall } from "../src/toolkit/tools/context";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { shardingToolCalls } from "./helpers/tool-calls";

// A demo run's first minute: thirteen agents claim their pieces at once, and the claims spread over records as the
// eighth arrives. Each agent then asks status about its change, as GitHive's agents do on their next turn. A claim
// that was made must read as made, and a claim that was refused must leave nothing behind.

let server: GitServer;
beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

const PIECES = ["board", "game", "help", "input", "message", "progress", "puzzle", "scoring", "share"];
const MORE = ["storage", "theme", "yesterday", "app"];

const pathsOf = (piece: string) => [`src/ui/${piece}.js`, `styles/${piece}.css`, `test/${piece}.test.js`];

describe("claims made all at once, across the switch to spreading them out", { timeout: 180_000 }, () => {
	it("read back as made, and leave nothing behind when refused", async () => {
		const { call } = shardingToolCalls(() => server);
		await call("settings", { required: 1, vetoes: [] });
		const pieces = [...PIECES, ...MORE];
		const claimed = await Promise.all(
			pieces.map((piece) =>
				call("claim", { change: `${piece}-1`, agent: `agent-${piece}`, paths: pathsOf(piece), intent: piece }),
			),
		);
		const outcomes = pieces.map((piece, index) => [piece, claimed[index]] as const);
		const made = outcomes.filter(([, outcome]) => outcome?.ok === true).map(([piece]) => piece);
		const refused = outcomes.filter(([, outcome]) => outcome?.ok !== true);
		// Each agent looks at its change, as on its next turn.
		const looked = await Promise.all(
			pieces.map(async (piece) => {
				const status = await call("status", { change: `${piece}-1` });
				return [piece, (status as { claim?: { agent?: string } | null }).claim?.agent ?? null] as const;
			}),
		);
		const missing = looked.filter(([piece, holder]) => made.includes(piece) && holder === null);
		const leftBehind = looked.filter(([piece, holder]) => !made.includes(piece) && holder !== null);
		expect({ refused: refused.map(([piece, outcome]) => [piece, outcome]), missing, leftBehind }).toEqual({
			refused: [],
			missing: [],
			leftBehind: [],
		});
	});
});

describe("a change's claim, read through a kept copy of the registry", { timeout: 60_000 }, () => {
	it("is found, though the copy is from before the claim, rather than reported missing", async () => {
		const remote = async () => ({ url: server.url, token: "unused" });
		const root = () => new GitCasLog<Registry>(remote, "p", "refs/notes/githive-claims/p");
		const writer = claimStore({ repo: "p", registry: null, root: root(), remote });
		const want = { agent: "agent-a", intent: "a", staleAfterMs: 60_000 };
		await writer.claim({ change: "other", paths: ["src/other/"], ...want });
		// A copy of the registry kept before the next claim, as a cache can hand a reader for a moment.
		const before = await root().read();
		await writer.claim({ change: "a-1", paths: ["src/a/"], ...want });
		const fresh = root();
		const kept: GitCasLog<Registry> = Object.assign(Object.create(fresh) as GitCasLog<Registry>, {
			read: async () => before,
		});
		const reader = claimStore({ repo: "p", registry: before?.commit.state, root: kept, remote });
		expect((await reader.readChange("a-1")).claim).toMatchObject({ change: "a-1", agent: "agent-a" });
	});
});

describe("a claim that fails partway", { timeout: 60_000 }, () => {
	it("gives back what it left in the agent's own name, and never another agent's", async () => {
		const remote = async () => ({ url: server.url, token: "unused" });
		const root = () => new GitCasLog<Registry>(remote, "p", "refs/notes/githive-claims/p");
		const store = claimStore({ repo: "p", registry: null, root: root(), remote });
		const want = { intent: "x", staleAfterMs: 60_000 };
		await store.claim({ change: "mine-1", agent: "agent-a", paths: ["src/a/"], ...want });
		await store.claim({ change: "theirs-1", agent: "agent-b", paths: ["src/b/"], ...want });
		const call = { stamper: undefined } as unknown as ToolCall;
		const giveBack = (change: string) => giveBackPartClaim(call, store, { change, agent: "agent-a", reason: "x" });
		expect(await giveBack("theirs-1")).toBe(false);
		expect((await store.readChange("theirs-1")).claim).toMatchObject({ agent: "agent-b" });
		expect(await giveBack("mine-1")).toBe(true);
		expect((await store.readChange("mine-1")).claim).toBeUndefined();
		expect(await giveBack("nothing-1")).toBe(false);
	});

	it("drops the note on records left behind once they're given back, unless renewing or the give-back failed", async () => {
		const left = { ok: false as const, conflicts: [], stillHeld: ["src/a"] };
		expect(await withoutLeftovers(left, false, async () => true)).toEqual({ ok: false, conflicts: [] });
		expect(await withoutLeftovers(left, false, async () => false)).toEqual(left);
		expect(await withoutLeftovers(left, true, async () => true)).toEqual(left);
		expect(await withoutLeftovers({ ok: true }, false, async () => true)).toEqual({ ok: true });
	});
});

describe("an agent's own open changes", { timeout: 60_000 }, () => {
	it("come with the lists it reads before taking more work, saying which have nothing pushed", async () => {
		const { call } = shardingToolCalls(() => server);
		await call("settings", { required: 1, vetoes: [] });
		await call("claim", { change: "c-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const backlog = await call("backlog", { agent: "agent-a" });
		expect(backlog).toMatchObject({ yours: [{ change: "c-1", pushed: false }] });
		expect(backlog.next).toMatch(/^You hold c-1 with nothing pushed/);
		expect(await call("reviews", { agent: "agent-a" })).toMatchObject({ yours: [{ change: "c-1", pushed: false }] });
		// Another agent's lists don't carry it.
		expect(await call("backlog", { agent: "agent-b" })).not.toHaveProperty("yours");
	});
});
