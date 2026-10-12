// Pushes, as Artifacts reports them. An agent pushes a change to its own fork, so without these events GitHive would
// have to read forks to learn changes' heads. Artifacts publishes a `repo.pushed` event to a Queue for every push,
// and one account-wide subscription carries every namespace's events, so each Worker filters for its own.
//
//   wrangler queues subscription create <queue> --source artifacts --events repo.pushed
//
// A noted head is only advice for what to review and batch; a merge still reads its own change. An agent can push
// any branch to its fork, so a head counts for a change only if it came to the fork of the agent holding the claim.
//
// The same events drive awareness (docs/awareness.md, "Footprints and interface news"), after the heads are noted and
// acked: each repo's pushes are handed to its FootprintCache, which reads and parses them in its own isolate (see
// awareness.ts).

import type { ChangePush, KnownHead } from "./repo-cache";
import { rpc } from "./rpc";

/**
 * The fields GitHive reads from a `cf.artifacts.repo.pushed` event's body. Artifacts also sends `commits` (at most
 * some, with messages and authors but no trees), `totalCommitsCount` and `commitsTruncated`; history is read through
 * its API instead, which has the trees.
 */
export interface PushedEvent {
	type?: string;
	source?: { namespace?: string; repoName?: string };
	payload?: { ref?: string; before?: string; after?: string };
	metadata?: { eventTimestamp?: string };
}

const CHANGE_REF = "refs/heads/changes/";
const BRANCH_REF = "refs/heads/";
const COMMIT = /^[0-9a-f]{40}$/;
const DELETED = /^0{40}$/;

/**
 * The change a push event is about: a push to `changes/<change>` on an agent's fork `fork--<project>--agent--<slug>`.
 * A project's name can contain `--`, so every place `--agent--` appears yields a candidate project.
 */
export function changePushOf(body: PushedEvent, namespace: string): { projects: string[]; push: ChangePush } | null {
	if (body.type !== "cf.artifacts.repo.pushed" || body.source?.namespace !== namespace) return null;
	const fork = body.source.repoName ?? "";
	const ref = body.payload?.ref ?? "";
	const after = body.payload?.after ?? "";
	const at = Date.parse(body.metadata?.eventTimestamp ?? "");
	const isChangeRef = ref.startsWith(CHANGE_REF) && ref.length > CHANGE_REF.length;
	if (!fork.startsWith("fork--") || !isChangeRef || !COMMIT.test(after) || Number.isNaN(at)) return null;
	const projects = candidateProjects(fork);
	if (!projects.length) return null;
	return {
		projects,
		push: { change: ref.slice(CHANGE_REF.length), fork, head: DELETED.test(after) ? null : after, at },
	};
}

/** A push to a branch of a project repo: a landing, or plain git. */
export interface BranchPush {
	repo: string;
	branch: string;
	/** Where the branch was: null when the push made it, absent when the event doesn't say. */
	before?: string | null;
	/** Where it is now: null when the push deleted it. */
	after: string | null;
	at: number;
}

/** The branch a push event moved on a project's own repo, in this namespace: not a fork's, nor a records repo's. */
export function branchPushOf(body: PushedEvent, namespace: string): BranchPush | null {
	if (body.type !== "cf.artifacts.repo.pushed" || body.source?.namespace !== namespace) return null;
	const repo = body.source.repoName ?? "";
	const ref = body.payload?.ref ?? "";
	const { before, after = "" } = body.payload ?? {};
	const at = Date.parse(body.metadata?.eventTimestamp ?? "");
	if (!repo || repo.startsWith("fork--") || repo.startsWith("records--")) return null;
	if (!ref.startsWith(BRANCH_REF) || ref.length === BRANCH_REF.length || !COMMIT.test(after) || Number.isNaN(at))
		return null;
	if (before !== undefined && !COMMIT.test(before)) return null;
	return {
		repo,
		branch: ref.slice(BRANCH_REF.length),
		...(before === undefined ? {} : { before: DELETED.test(before) ? null : before }),
		after: DELETED.test(after) ? null : after,
		at,
	};
}

/** Every project a fork's name could belong to: what precedes each `--agent--` followed by a slug. */
function candidateProjects(fork: string) {
	const projects: string[] = [];
	const prefix = "fork--".length;
	const marker = "--agent--";
	for (let at = fork.indexOf(marker, prefix); at > prefix; at = fork.indexOf(marker, at + 1))
		if (at + marker.length < fork.length) projects.push(fork.slice(prefix, at));
	return projects;
}

/** One repo's pushes for awareness: to its branches, oldest first, and each change's newest to an agent's fork. */
export interface RepoPushes {
	moved: BranchPush[];
	pushed: ChangePush[];
}

/** Hands one repo's pushes to where awareness works them out: the repo's FootprintCache. */
export type AwarenessHandOff = (repo: string, pushes: RepoPushes) => Promise<unknown>;

/**
 * The Worker's queue consumer. It notes each batch's pushes in their projects' RepoCaches, one call per project, and
 * acks them; then, given a hand-off, it hands each repo's pushes on for awareness.
 */
export async function notePushEvents(batch: MessageBatch<unknown>, env: Env, handOff?: AwarenessHandOff | null) {
	const namespace = (env as unknown as { ARTIFACTS_NAMESPACE?: string }).ARTIFACTS_NAMESPACE;
	const byProject = new Map<string, { pushes: ChangePush[]; messages: Message<unknown>[] }>();
	for (const message of batch.messages) {
		const found = namespace ? changePushOf(message.body as PushedEvent, namespace) : null;
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
				for (const message of messages) failed.add(message);
			}
		}),
	);
	// Noting is idempotent because the newest push wins, so a message that failed for any project is retried whole.
	const noted = new Set([...byProject.values()].flatMap((entry) => entry.messages));
	for (const message of noted) {
		if (failed.has(message)) message.retry();
		else message.ack();
	}
	// Acked first: awareness is advice, so a failure there, or running out of time, never has a push delivered again.
	// A message being retried comes back, and is looked at then.
	if (!handOff || !namespace) return;
	const byRepo = pushesByRepo(
		batch.messages.filter((message) => !failed.has(message)),
		namespace,
	);
	await Promise.all(
		[...byRepo].map(([repo, pushes]) =>
			handOff(repo, pushes).catch((err) =>
				console.error(`awareness for ${repo}'s pushes failed in its FootprintCache: ${String(err)}`),
			),
		),
	);
}

// Each repo's pushes for awareness. A push to a fork is handed to every project its name may belong to; only the
// one whose claim holder's fork took it counts it.
function pushesByRepo(messages: Message<unknown>[], namespace: string) {
	const moved: BranchPush[] = [];
	const pushed = new Map<string, NonNullable<ReturnType<typeof changePushOf>>>();
	for (const message of messages) {
		const body = message.body as PushedEvent;
		const branch = branchPushOf(body, namespace);
		if (branch) moved.push(branch);
		const change = changePushOf(body, namespace);
		if (!change) continue;
		const key = `${change.push.fork}\0${change.push.change}`;
		const newest = pushed.get(key)?.push.at ?? -Infinity;
		if (newest <= change.push.at) pushed.set(key, change);
	}
	const byRepo = new Map<string, RepoPushes>();
	const pushesOf = (repo: string) => {
		if (!byRepo.has(repo)) byRepo.set(repo, { moved: [], pushed: [] });
		return byRepo.get(repo)!;
	};
	for (const push of moved.sort((a, b) => a.at - b.at)) pushesOf(push.repo).moved.push(push);
	for (const { projects, push } of pushed.values()) for (const project of projects) pushesOf(project).pushed.push(push);
	return byRepo;
}

/**
 * The kept heads that count for these claims: heads read from a fork, and heads a push event noted on the fork of the
 * agent holding the claim. Other changes count as unseen and are read.
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
