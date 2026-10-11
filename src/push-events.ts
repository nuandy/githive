// Pushes, as Artifacts reports them. An agent pushes a change to its own fork, so without these events GitHive would
// have to read forks to learn changes' heads. Artifacts publishes a `repo.pushed` event to a Queue for every push,
// and one account-wide subscription carries every namespace's events, so each Worker filters for its own.
//
//   wrangler queues subscription create <queue> --source artifacts --events repo.pushed
//
// A noted head is only advice for what to review and batch; a merge still reads its own change. An agent can push
// any branch to its fork, so a head counts for a change only if it came to the fork of the agent holding the claim.
//
// The same events drive awareness (docs/awareness.md, "Footprints and interface news"), after the heads are noted
// and acked: a push to a change's branch footprints the change and tells heads-ups between open changes, and a push to
// a project's branch (a landing, or plain git) tells the open changes that use what it altered. That work is advice:
// it's bounded by counts, logged when it fails, and never retried.

import type { FootprintCache, LandedCommit } from "./footprint-cache";
import type { CommitMeta, HistorySource } from "./toolkit/branch-history";
import { changeFootprint, commitAlters, type FactsSource, landingOf } from "./footprint/footprints";
import type { ChangePush, KnownHead } from "./repo-cache";
import { rpc } from "./rpc";
import { changeAgainst, type ReadHistory } from "./toolkit/batch-reads";

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

/**
 * The Worker's queue consumer. It notes each batch's pushes in their projects' RepoCaches, one call per project, and
 * acks them; then, given its parts, it works out what the pushes mean for awareness.
 */
export async function notePushEvents(batch: MessageBatch<unknown>, env: Env, aware?: AwarenessParts | null) {
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
	if (aware && namespace)
		await awareness(
			batch.messages.filter((message) => !failed.has(message)),
			namespace,
			aware,
		).catch((err) => console.error(`awareness for ${batch.messages.length} push events failed: ${String(err)}`));
}

/** A claim as awareness reads it from the claims advice. */
export type ClaimView = { change: string; agent: string; intent?: string; into?: string };

/** The FootprintCache calls awareness makes. */
export type FootprintStore = Pick<
	FootprintCache,
	"factsOf" | "keepFacts" | "keptHead" | "branchState" | "analysed" | "keep" | "drop" | "landed"
>;

/** What awareness reads and keeps through (see awarenessParts in footprint-cache.ts); tests pass their own. */
export interface AwarenessParts {
	/** Any repo's history through Artifacts' API: a project's, or a fork's. */
	history: ReadHistory;
	/** The project's branch and the claims in force, or null when GitHive hasn't started on the repo. */
	claims(repo: string): Promise<{ branch: string; claims: ClaimView[] } | null>;
	branchHead(repo: string, branch: string): Promise<string | null>;
	/** An agent's fork of the project. */
	forkOf(repo: string, agent: string): Promise<string>;
	footprints(repo: string): FootprintStore;
}

/** What one batch may parse, by count: a Worker's clock stands still during CPU work, so time can't be the budget. */
const PARSES_PER_BATCH = 400;
const CHARS_PER_BATCH = 16_000_000;
/** The most Artifacts reads one batch makes for awareness, well inside an invocation's 10,000 subrequests. */
const READS_PER_BATCH = 4_000;
/** The most first-parent commits one push to a project's branch is analysed for. */
export const LANDED_COMMITS = 50;

// The batch's pushes for awareness: branch pushes first, so a change that landed is dropped before others are compared
// with it, then each change's newest push. Each is caught and logged on its own.
async function awareness(messages: Message<unknown>[], namespace: string, parts: AwarenessParts) {
	const budget = { parses: PARSES_PER_BATCH, chars: CHARS_PER_BATCH };
	const claimsRead = new Map<string, ReturnType<AwarenessParts["claims"]>>();
	const reads = { left: READS_PER_BATCH };
	const once: AwarenessParts = {
		...parts,
		history: (repo, read) => parts.history(repo, (source) => read(counted(source, reads))),
		claims: (repo) => {
			if (!claimsRead.has(repo)) claimsRead.set(repo, parts.claims(repo));
			return claimsRead.get(repo)!;
		},
	};
	const moved: BranchPush[] = [];
	const pushed = new Map<string, NonNullable<ReturnType<typeof changePushOf>>>();
	for (const message of messages) {
		const body = message.body as PushedEvent;
		const branch = branchPushOf(body, namespace);
		if (branch) moved.push(branch);
		const change = changePushOf(body, namespace);
		const key = change && `${change.push.fork}\0${change.push.change}`;
		if (change && key && (pushed.get(key)?.push.at ?? -Infinity) <= change.push.at) pushed.set(key, change);
	}
	for (const push of moved.sort((a, b) => a.at - b.at))
		await branchMoved(once, push, budget).catch((err) =>
			console.error(`awareness: analysing ${push.repo}'s ${push.branch} at ${push.after} failed: ${String(err)}`),
		);
	for (const found of pushed.values())
		await footprintChange(once, found, budget).catch((err) =>
			console.error(`awareness: footprinting ${found.push.change} from ${found.push.fork} failed: ${String(err)}`),
		);
}

// A history source that gives up once the batch's reads run out: the event at hand fails, is logged, and the rest
// of the batch fails fast the same way.
function counted(source: HistorySource, reads: { left: number }): HistorySource {
	const spend = () => {
		if (reads.left-- <= 0) throw new Error(`this batch's ${READS_PER_BATCH} Artifacts reads for awareness ran out`);
	};
	const readBlob = source.readBlob?.bind(source);
	return {
		log: async (ref, limit, offset) => (spend(), source.log(ref, limit, offset)),
		readCommit: async (hash) => (spend(), source.readCommit(hash)),
		readTree: async (hash) => (spend(), source.readTree(hash)),
		...(readBlob ? { readBlob: async (hash: string) => (spend(), readBlob(hash)) } : {}),
	};
}

const factsSource = (store: FootprintStore, budget: FactsSource["budget"]): FactsSource => ({
	kept: (keys) => rpc(store.factsOf(keys)),
	keep: (facts) => store.keepFacts(facts),
	budget,
});

const openClaims = (claims: ClaimView[]) => Object.fromEntries(claims.map((claim) => [claim.change, claim.agent]));

/**
 * A push to a change's branch on its agent's fork: the change's footprint, read from the fork against its base, and
 * the heads-ups it raises. Only a change claimed by the agent whose fork took the push counts.
 */
async function footprintChange(
	parts: AwarenessParts,
	{ projects, push }: NonNullable<ReturnType<typeof changePushOf>>,
	budget: FactsSource["budget"],
) {
	for (const project of projects) {
		const claimed = await parts.claims(project);
		const claim = claimed?.claims.find((each) => each.change === push.change);
		if (!claimed || !claim || (await parts.forkOf(project, claim.agent)) !== push.fork) continue;
		const store = parts.footprints(project);
		if (!push.head) return void (await store.drop([push.change]));
		const kept = await rpc(store.keptHead(push.change));
		if (kept && (kept.head === push.head || kept.at > push.at)) return;
		const branch = claim.into ?? claimed.branch;
		const main = await parts.branchHead(project, branch);
		if (!main) return;
		// changeAgainst names the repo to read a change from by its URL; the fork's name is all it takes from it.
		const source = { url: `https://artifacts.invalid/${push.fork}.git` };
		const placed = await changeAgainst(parts.history, project, branch, main, { ref: push.head, source });
		if (!placed || "error" in placed) {
			console.log(`awareness: ${push.change} at ${push.head} couldn't be placed on ${branch}; no footprint`);
			return;
		}
		const read = await parts.history(push.fork, (fork) =>
			changeFootprint(fork, { head: placed.head, base: placed.base, files: placed.files }, factsSource(store, budget)),
		);
		if (!read) return;
		await store.keep(
			project,
			{
				change: push.change,
				agent: claim.agent,
				...(claim.intent ? { intent: claim.intent } : {}),
				branch,
				head: placed.head,
				base: placed.base,
				at: push.at,
				...read,
			},
			openClaims(claimed.claims),
		);
		return;
	}
}

/**
 * A push to a project's branch: each new first-parent commit, oldest first, against its first parent (a GitHive
 * merge's first parent is the branch before it, so that's the change's effect), told to the open changes that use
 * what it altered. Nothing is read while no open change goes into the branch.
 */
async function branchMoved(parts: AwarenessParts, push: BranchPush, budget: FactsSource["budget"]) {
	if (!push.after) return;
	const store = parts.footprints(push.repo);
	const { open, last } = await rpc(store.branchState(push.branch));
	// A new branch starts where another was: nothing landed on it yet.
	if (!open || push.before === null) return void (await store.analysed(push.branch, push.after));
	const after = push.after;
	const chain = await parts.history(push.repo, (source) => source.log(after, LANDED_COMMITS + 1, 0));
	const stops = new Set([push.before, last].filter((each): each is string => !!each));
	const end = chain.findIndex((commit) => stops.has(commit.hash));
	let commits: CommitMeta[];
	if (end >= 0) commits = chain.slice(0, end);
	// The first event for the branch, without where it was: just the commit pushed.
	else if (!stops.size) commits = chain.slice(0, 1);
	else {
		commits = chain.slice(0, LANDED_COMMITS);
		if (chain.length > LANDED_COMMITS)
			console.log(`awareness: ${push.repo}'s ${push.branch} moved past ${LANDED_COMMITS} commits; the newest analysed`);
	}
	const landed: LandedCommit[] = [];
	await parts.history(push.repo, async (source) => {
		for (let index = commits.length - 1; index >= 0; index--) {
			const commit = commits[index]!;
			const first = commit.parents[0];
			const next = chain[index + 1];
			const parentTree = !first
				? null
				: next?.hash === first
					? next.treeHash
					: ((await source.log(first, 1, 0))[0]?.treeHash ?? null);
			// A parent that can't be read leaves the commit's alterations unknown, never everything "added".
			const alters =
				first && !parentTree ? [] : await commitAlters(source, commit, parentTree, factsSource(store, budget));
			landed.push({ ...landingOf(commit), alters });
		}
	});
	const claimed = landed.some((commit) => commit.alters.length) ? await parts.claims(push.repo) : null;
	await store.landed(push.repo, push.branch, landed, claimed ? openClaims(claimed.claims) : {}, after);
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
