import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { memoryLanding } from "../src/toolkit/landing";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// A demo run's whole life at once, with the store failing under it. Thirteen agents take pieces from the backlog,
// claim, push, get reviewed and merge, all at the same time, while claims spread over records as the eighth claims.
// Meanwhile the server keeps failing: pushes refused, pushes answered with an error after they were applied (a write
// that happened though the caller was told it didn't), fetches failing. Each agent does what GitHive's agents do:
// it retries a failed turn, follows its own changes, and gives back a claim it doesn't know it holds. At the end
// every piece has landed exactly once, no claim is left, and the audit finds nothing wrong.

const AGENTS = 13;
const RUN_WITHIN_MS = 240_000;
/** How often the server is made to fail one more request. */
const FAULT_EVERY_MS = 400;

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

const pieces = Array.from({ length: AGENTS }, (_, index) => `piece-${index}`);

function context(): ToolContext {
	const remote = async () => ({ url: server.url, token: "unused" });
	const landing = memoryLanding();
	return {
		remote,
		changeRemote: remote,
		batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		recordsRemote: async (_repo, k) => ({ url: server.repo(`rec-${k}`), token: "unused" }),
		createRecordsRepos: async () => undefined,
		landing: () => landing,
	};
}

type Reply = Record<string, unknown> & {
	ok?: boolean;
	open?: { id: string }[];
	yours?: { change: string; pushed: boolean }[];
};

/** Makes the server fail one more request every so often, a different way each time, until stopped. */
function keepFailing() {
	const ways = [
		() => server.failPushes(1, true),
		() => server.failPushes(1, false),
		() => server.failFetches(1),
		() => server.busyPushes(1),
	];
	let next = 0;
	const timer = setInterval(() => {
		ways[next % ways.length]!();
		next++;
	}, FAULT_EVERY_MS);
	return () => clearInterval(timer);
}

/** One agent's run: take a piece, build, get it reviewed, merge, and again until nothing is left for it. */
async function agentRun(agent: string, ctx: ToolContext, deadline: number) {
	const call = (name: string, args: Record<string, unknown>) =>
		callTool(name, { repo: "p", agent, ...args }, ctx) as Promise<Reply>;
	let piece: string | undefined;
	while (Date.now() < deadline) {
		try {
			const backlog = await call("backlog", {});
			// A claim in its name it doesn't know it holds, with nothing pushed: give it back.
			for (const yours of backlog.yours ?? [])
				if (!yours.pushed && yours.change !== piece) await call("release", { change: yours.change });
			if (!piece) {
				const free = backlog.open?.[0];
				if (!free && !backlog.yours?.length) return;
				if (free) {
					const claimed = await call("claim", { change: free.id, paths: [`src/${free.id}/`], intent: free.id });
					if (claimed.ok) piece = free.id;
				}
			} else piece = await advance(call, agent, piece, ctx);
		} catch {
			// A failed turn: the next one tries again, as GitHive's agents do.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** One step for the agent's piece; undefined once it's landed or no longer the agent's. */
async function advance(
	call: (name: string, args: Record<string, unknown>) => Promise<Reply>,
	agent: string,
	piece: string,
	ctx: ToolContext,
) {
	const status = (await call("status", { change: piece })) as Reply & {
		claim?: unknown;
		head?: string | null;
		landed?: unknown;
		approval?: { approved?: boolean };
	};
	if (status.landed) return undefined;
	if (!status.claim) return undefined;
	if (!status.head) {
		await pushChange(server.url, work, agent, piece, {
			[`src/${piece}/index.js`]: `export const ${piece.replace("-", "")} = 1;\n`,
		});
		return piece;
	}
	if (!status.approval?.approved) {
		await callTool(
			"vote",
			{
				repo: "p",
				commit: status.head,
				change: piece,
				reviewer: "reviewer",
				role: "review",
				verdict: "approve",
				evidence: "ok",
			},
			ctx,
		).catch(() => undefined);
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

	it(
		"lands every piece once and leaves no claim, however the store fails",
		{ timeout: RUN_WITHIN_MS + 60_000 },
		async () => {
			const ctx = context();
			const setup = (name: string, args: Record<string, unknown>) => callTool(name, { repo: "p", ...args }, ctx);
			await setup("settings", { required: 1, vetoes: [] });
			await setup("add_work", {
				agent: "planner",
				items: pieces.map((id) => ({ id, title: id, intent: `build ${id}`, paths: [`src/${id}/`] })),
			});
			const stop = keepFailing();
			const deadline = Date.now() + RUN_WITHIN_MS;
			try {
				await Promise.all(Array.from({ length: AGENTS }, (_, index) => agentRun(`agent-${index}`, ctx, deadline)));
			} finally {
				stop();
			}
			const claims = (await setup("claims", {})) as { change: string }[];
			const audit = (await setup("audit", {}).catch((err) => ({ error: statusOf(err).message }))) as Reply;
			// Merge commits only: each piece's own commit is on main too.
			const landed = server
				.git("log", "--merges", "--format=%s", "main")
				.split("\n")
				.filter((subject) => /piece-\d+/.test(subject));
			expect({ left: claims.map((claim) => claim.change), audit }).toEqual({
				left: [],
				audit: { merges: AGENTS, open: 0, violations: [] },
			});
			expect(landed).toHaveLength(AGENTS);
		},
	);
});
