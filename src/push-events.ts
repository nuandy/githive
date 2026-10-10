// Pushes, as Artifacts reports them. An agent pushes a change to its own fork,
// where GitHive doesn't see it; reviews, backlog and merge then had to read
// forks to learn changes' heads (see openHeads in toolkit/mcp.ts). Artifacts
// publishes a `repo.pushed` event to a Queue for every push, and one
// account-wide subscription carries all of them (every namespace's: a
// Worker keeps its own). The Worker's queue consumer notes each push to a
// change's branch in its project's RepoCache, so a change's head is known
// about two seconds after its push, without reading its fork.
//
//   wrangler queues subscription create <queue> --source artifacts --events repo.pushed
//
// A head is advice (what to review, what to batch): a merge still reads its
// own change. Pushes to an agent's fork can only come from that agent, but an
// agent can push any branch to its fork, so a head an event noted counts for a
// change only if it came to the fork of the agent holding its claim.

import type { ChangePush, KnownHead } from "./repo-cache";
import { rpc } from "./rpc";

/** A `cf.artifacts.repo.pushed` event's body: the fields GitHive reads. */
export interface PushedEvent {
	type?: string;
	source?: { namespace?: string; repoName?: string };
	payload?: { ref?: string; after?: string };
	metadata?: { eventTimestamp?: string };
}

const CHANGE_REF = "refs/heads/changes/";
const DELETED = /^0{40}$/;

/**
 * The change a push event is about, if any: a push to `changes/<change>` on
 * an agent's fork (`fork--<project>--agent--<slug>`, see forkName) in
 * `namespace`. A project's name can hold `--`, so each place `--agent--`
 * appears names a project it may be (almost always one). Pushes to projects,
 * seed forks, records repos and other branches are no change's.
 */
export function changePushOf(body: PushedEvent, namespace: string): { projects: string[]; push: ChangePush } | null {
	if (body.type !== "cf.artifacts.repo.pushed" || body.source?.namespace !== namespace) return null;
	const fork = body.source.repoName ?? "";
	const ref = body.payload?.ref ?? "";
	const after = body.payload?.after ?? "";
	const at = Date.parse(body.metadata?.eventTimestamp ?? "");
	if (
		!fork.startsWith("fork--") ||
		!ref.startsWith(CHANGE_REF) ||
		ref.length === CHANGE_REF.length ||
		!/^[0-9a-f]{40}$/.test(after) ||
		Number.isNaN(at)
	)
		return null;
	const projects: string[] = [];
	for (let i = fork.indexOf("--agent--", 6); i > 6; i = fork.indexOf("--agent--", i + 1))
		if (i + 9 < fork.length) projects.push(fork.slice(6, i));
	if (!projects.length) return null;
	return {
		projects,
		push: { change: ref.slice(CHANGE_REF.length), fork, head: DELETED.test(after) ? null : after, at },
	};
}

/** The Worker's queue consumer: each batch's pushes noted in their projects' RepoCaches, one call a project. */
export async function notePushEvents(batch: MessageBatch<unknown>, env: Env) {
	const namespace = (env as unknown as { ARTIFACTS_NAMESPACE?: string }).ARTIFACTS_NAMESPACE;
	const byProject = new Map<string, { pushes: ChangePush[]; messages: Message<unknown>[] }>();
	for (const message of batch.messages) {
		const found = namespace ? changePushOf(message.body as PushedEvent, namespace) : null;
		// Not a change's push (or not this Worker's namespace): nothing to note.
		if (!found) {
			message.ack();
			continue;
		}
		for (const project of found.projects) {
			const entry = byProject.get(project) ?? { pushes: [], messages: [] };
			entry.pushes.push(found.push);
			entry.messages.push(message);
			byProject.set(project, entry);
		}
	}
	const failed = new Set<Message<unknown>>();
	await Promise.all(
		[...byProject].map(async ([project, { pushes, messages }]) => {
			try {
				await rpc(env.REPO_CACHE.getByName(`repo:${project}`).notePushes(pushes));
			} catch (err) {
				console.error(`noting ${pushes.length} pushes in ${project}'s RepoCache failed: ${String(err)}`);
				for (const m of messages) failed.add(m);
			}
		}),
	);
	// Noting is idempotent (the newest push wins), so a message whose noting failed anywhere is delivered again whole.
	for (const m of new Set([...byProject.values()].flatMap((e) => e.messages))) {
		if (failed.has(m)) m.retry();
		else m.ack();
	}
}

/**
 * Of a RepoCache's kept heads, those that count for these claims: a head read
 * from a fork, or one a push event noted on the fork of the agent holding the
 * claim (`forkOf`: see forkName). Any other event's head is left out, so its
 * change counts as unseen and is read.
 */
export async function headsForClaims(
	kept: Record<string, KnownHead>,
	claims: { change: string; agent: string }[],
	forkOf: (agent: string) => Promise<string>,
) {
	const forks = new Map<string, Promise<string>>();
	const counted: Record<string, KnownHead & { pushed?: boolean }> = {};
	for (const { change, agent } of claims) {
		const known = kept[change];
		if (!known) continue;
		if (known.fork === undefined) counted[change] = { head: known.head, at: known.at };
		else {
			if (!forks.has(agent)) forks.set(agent, forkOf(agent));
			if (known.fork === (await forks.get(agent))) counted[change] = { head: known.head, at: known.at, pushed: true };
		}
	}
	return counted;
}
