import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../../src/toolkit/mcp";
import { pushChange } from "../helpers/agents";
import { startGitServer, type GitServer } from "../helpers/git-server";
import { keepFailing, runOutcome, seedRun, soakContext, soakPieces } from "../helpers/soak";

// A demo run's whole life at once, with the store failing under it. Thirteen agents from outside GitHive take pieces
// from the backlog, claim, push, get reviewed and merge, all at the same time, while claims spread over records as
// the eighth claims. Meanwhile the server keeps failing: pushes refused, pushes answered with an error after they
// were applied (a write that happened though the caller was told it didn't), fetches failing. Each agent retries a
// failed turn, gives back a claim it doesn't know it holds, and with nothing to do calls `wait`, which holds until
// the repo's doorbell (a real RepoCache) rings for something that concerns it. At the end every piece has landed
// exactly once, no claim is left, and the audit finds nothing wrong; a ring an agent should have had would leave a
// piece untaken until the deadline.

const AGENTS = 13;
/** Pieces free at the start; the rest wait on one a layer before them. */
const FIRST_LAYER = 5;
const RUN_WITHIN_MS = 240_000;
/** How long an idle agent's `wait` holds: long enough that a missed ring would show as a stalled run. */
const WAIT_SECONDS = 8;

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-soak-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

type Reply = Record<string, unknown> & {
	ok?: boolean;
	open?: { id: string }[];
	waiting?: { id: string }[];
	yours?: { change: string; pushed: boolean }[];
	seen?: string;
	changed?: boolean;
};
/** An idle agent's waits: how many, how many heard nothing, and how many of those missed work that was free. */
interface Waits {
	idle: number;
	quiet: number;
	missed: number;
}
type Call = (name: string, args: Record<string, unknown>) => Promise<Reply>;

/** One agent's run: take a piece, build, get it reviewed, merge, and again until nothing is left anywhere. */
async function agentRun(agent: string, ctx: ToolContext, deadline: number, waits: Waits) {
	const call: Call = (name, args) => callTool(name, { repo: "p", agent, ...args }, ctx) as Promise<Reply>;
	let piece: string | undefined;
	let seen: string | undefined;
	let timedOut = false;
	while (Date.now() < deadline) {
		let acted: boolean;
		try {
			const backlog = await call("backlog", {});
			if (!piece && nothingLeft(backlog)) return;
			if (timedOut && backlog.open?.length) seen = await checkRang(call, seen!, waits);
			timedOut = false;
			acted = await giveBackStrays(call, backlog, piece);
			if (piece) {
				piece = await advance(call, agent, piece, ctx);
				acted = true;
			} else if (backlog.open?.[0]) {
				const free = backlog.open[0];
				const claimed = await call("claim", { change: free.id, paths: [`src/${free.id}/`], intent: free.id });
				if (claimed.ok) piece = free.id;
				acted = true;
			}
		} catch {
			// A failed turn: the next one tries again, as GitHive's agents do.
			await new Promise((resolve) => setTimeout(resolve, 50));
			continue;
		}
		if (acted) continue;
		// Nothing to do: wait until something that concerns this agent changes.
		waits.idle++;
		const waited = await call("wait", { seconds: WAIT_SECONDS, ...(seen ? { seen } : {}) }).catch(() => null);
		timedOut = waited?.changed === false;
		if (timedOut) waits.quiet++;
		if (waited?.seen) seen = waited.seen;
	}
}

/**
 * After a wait that heard nothing, work is free: asks the doorbell, with the same `seen`, whether anything rang for
 * the agent since. Work that freed itself after the hold ended rang, and a wait answers at once; one that freed
 * silently is a ring the agent missed.
 */
async function checkRang(call: Call, seen: string, waits: Waits) {
	const again = await call("wait", { seconds: 1, seen });
	if (again.changed === false) waits.missed++;
	return again.seen ?? seen;
}

/** Whether every piece has landed: none free, none waiting, none in the agent's name. */
function nothingLeft(backlog: Reply) {
	const pieces = [...(backlog.open ?? []), ...(backlog.waiting ?? []), ...(backlog.yours ?? [])];
	return pieces.length === 0;
}

/** Gives back claims in the agent's name it doesn't know it holds, with nothing pushed; whether it gave any back. */
async function giveBackStrays(call: Call, backlog: Reply, piece: string | undefined) {
	const strays = (backlog.yours ?? []).filter((yours) => !yours.pushed).filter((yours) => yours.change !== piece);
	for (const stray of strays) await call("release", { change: stray.change });
	return strays.length > 0;
}

/** One step for the agent's piece; undefined once it's landed or no longer the agent's. */
async function advance(call: Call, agent: string, piece: string, ctx: ToolContext) {
	const status = (await call("status", { change: piece })) as Reply & {
		claim?: unknown;
		head?: string | null;
		landed?: unknown;
		approval?: { approved?: boolean };
	};
	if (status.landed) return undefined;
	if (!status.claim) return undefined;
	if (!status.head) {
		const file = `src/${piece}/index.js`;
		await pushChange(server.url, work, agent, piece, { [file]: `export const ${piece.replace("-", "")} = 1;\n` });
		return piece;
	}
	if (!status.approval?.approved) {
		const vote = { commit: status.head, change: piece, role: "review", verdict: "approve", evidence: "ok" };
		await callTool("vote", { repo: "p", reviewer: "reviewer", ...vote }, ctx).catch(() => undefined);
		return piece;
	}
	await call("merge", { change: piece });
	return piece;
}

// Batches land with trees in the Worker, or in the Gate when they can't: the run goes both ways.
describe.each([
	["with trees in the Worker", "1"],
	["in the Gate", "0"],
])("a run under failures, landing %s", (_, treeLanding) => {
	let was: string | undefined;
	beforeEach(() => {
		was = process.env.TREE_LANDING;
		process.env.TREE_LANDING = treeLanding;
	});
	afterEach(() => {
		if (was === undefined) delete process.env.TREE_LANDING;
		else process.env.TREE_LANDING = was;
	});

	const timeout = RUN_WITHIN_MS + 60_000;
	it("lands every piece once and leaves no claim, however the store fails", { timeout }, async () => {
		const ctx = soakContext(server);
		await seedRun(ctx, soakPieces(AGENTS, FIRST_LAYER));
		const stop = keepFailing(server);
		const deadline = Date.now() + RUN_WITHIN_MS;
		const waits = { idle: 0, quiet: 0, missed: 0 };
		try {
			const agents = Array.from({ length: AGENTS }, (_, index) => `agent-${index}`);
			await Promise.all(agents.map((agent) => agentRun(agent, ctx, deadline, waits)));
		} finally {
			stop();
		}
		console.log(`soak, landing ${treeLanding === "1" ? "with trees" : "in the Gate"}: ${JSON.stringify(waits)}`);
		expect(waits.missed).toBe(0);
		expect(await runOutcome(server, ctx)).toEqual({
			left: [],
			audit: { merges: AGENTS, open: 0, violations: [] },
			landed: AGENTS,
		});
	});
});
