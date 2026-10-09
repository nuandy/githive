import { FORMAT_TRAILER, RECORD_FORMAT } from "../record-format";
import git from "isomorphic-git";
import { BOT, branchHead, type Remote, Workspace } from "../git";
import { inLane } from "../claim-paths";
import type { ClaimStore } from "./claim-store";
import { mergeStampPayload } from "./audit";
import type { Stamper } from "./stamp";
import type { VoteStore } from "./vote-store";
import { type ReviewPolicy, approval, countedVotes, effectivePolicy } from "./votes";

// The toolkit's merge for a cooperative agent. It
// checks the conventions the agent follows (its claim covers every file it
// changed, no one else's claim does, the reviewed commit has the approvals, it
// merges into main without conflicts, and the project's checks pass on main
// plus the change) and refuses to help break them. It decides nothing that
// binds anyone: an agent can merge with plain git instead, and the audit sees
// the same records.

const ATTEMPTS = 3;

/** One check command's result. */
export interface CheckResult {
	command: string;
	exitCode: number;
	output: string;
}

/**
 * Runs the project's checks on `base` (main) with `head` (from branch `ref`)
 * merged in. Live, in the repo's line of merges (see line.ts): the result
 * says which main they ran on (`base`, by default the one given) and which
 * merges ahead were merged in first (`after`), which must land first.
 */
export type CheckRunner = (input: { change: string; base: string; branch?: string; head: string; ref: string; commands: string[]; source?: Remote; agent?: string }) => Promise<{
	passed: boolean;
	results: CheckResult[];
	base?: string;
	after?: { change: string; head: string }[];
	/** Tells the line the merge is done with this result: it landed (as `commit`), or (false) gave up and checks again if it tries again. */
	done?: (landed: boolean, commit?: string) => Promise<void>;
	/** While the merge waits for its turn: whether it still holds its place in line (false: one ahead left, so check again). */
	inLine?: () => Promise<boolean>;
}>;

/** How long a merge waits for the merges ahead of it in line to land, before it checks again without them. */
export const TURN_WAIT_MS = 5 * 60_000;
const TURN_POLL_MS = 3_000;

export interface MergeInput {
	remote: Remote;
	/** The project's branch the change merges into. */
	branch: string;
	/** Where the change's branch lives (its fork); by default the project repo. */
	source?: Remote;
	/** The repo's claims: checked before merging, cited on the merge, released after. */
	store: ClaimStore;
	/** The repo's votes: counted on the change's head, and cited on the merge. */
	votes: VoteStore;
	policy: ReviewPolicy;
	/** The project's checks; none means the merge isn't tested. */
	verify?: string[];
	runChecks?: CheckRunner;
	/** Stamps the merge (and the release) with the caller's verified identity. */
	stamper?: Stamper;
	/** The registry's stamp key: when set, only stamped votes count. */
	stampKey?: string;
	change: string;
	agent: string;
	/** A file as the claims records name it, for a change into a branch other than the project's (see branch-scope.ts). */
	scope?: (file: string) => string;
	/**
	 * The branch's head, as kept a moment for every merge watching it (a crowd
	 * waiting in line would otherwise list it every few seconds each). Absent:
	 * listed each time. A head a moment old is safe: a merge pushes by
	 * compare-and-swap, and tries again when the branch moved.
	 */
	branchHead?: () => Promise<string | null>;
	/** How long to wait for the merges ahead in line to land (TURN_WAIT_MS unless set, as tests do). */
	turnWaitMs?: number;
}

export type MergeOutcome =
	| { ok: true; commit: string }
	| { ok: false; reasons: string[]; conflicts?: string[]; checks?: CheckResult[] };

/**
 * Merge `changes/<change>` into main, with trailers naming the change, the
 * agent, and the claims and votes it checked; then release the claim, naming
 * the merge. If main moved meanwhile (another merge), check again and retry.
 */
export async function mergeChange(input: MergeInput): Promise<MergeOutcome> {
	for (let attempt = 1; ; attempt++) {
		// From the branch as kept for the isolate (see Workspace.at): one listing, no clone.
		const listed = (await headOf(input)) ?? fail409(`there's no branch ${input.branch}`);
		const ws = await Workspace.at(input.remote, input.branch, listed);
		const main = await ws.head();
		const head = await ws.fetch("change", input.source ?? input.remote, `changes/${input.change}`);
		const files = await ws.changedPaths(await ws.mergeBase(main, head), head);
		// The same files as the claims records name them: in the branch's own part, for a branch other than the project's.
		const scoped = input.scope ? files.map(input.scope) : files;
		// The claims that bear on these files (the change's own, and any covering them), and the votes on its head.
		const [view, votes] = await Promise.all([input.store.readScope(input.change, scoped), input.votes.readFor([head])]);

		const reasons: string[] = [];
		const claims = view.claims;
		const own = claims.find((c) => c.change === input.change);
		if (!own) reasons.push(`${input.change} holds no claim`);
		files.forEach((file, i) => {
			const holder = claims.find((c) => c.change !== input.change && inLane(scoped[i], c.paths));
			if (holder) reasons.push(`${file} is inside ${holder.change}'s claim (${holder.agent})`);
			else if (own && !inLane(scoped[i], own.paths)) reasons.push(`${file} is outside ${input.change}'s claim`);
		});
		const counted = await countedVotes(votes.votes, input.stampKey);
		// Distinct reviewers, never the change's author: its claim's agent, and who made the claim.
		// The policy for what it touches: stricter for dependency, CI and deploy files, say.
		const outcome = approval({ votes: counted }, head, input.policy, own, files);
		const { required } = effectivePolicy(input.policy, files);
		if (outcome.vetoedBy.length) reasons.push(`${head} is vetoed by ${outcome.vetoedBy.join(", ")}`);
		else if (outcome.approvals < required) reasons.push(`${head} has ${outcome.approvals} of ${required} approvals from reviewers other than its author`);
		else if (outcome.awaiting.length) reasons.push(`${head} still needs approval from ${outcome.awaiting.join(", ")}, which can veto it`);
		if (reasons.length) return { ok: false, reasons };

		const tried = await ws.tryMerge(main, head);
		if (!tried.clean) {
			const files = tried.files ?? [];
			return {
				ok: false,
				conflicts: files,
				reasons: [`changes/${input.change} conflicts with ${ws.branch} in ${files.join(", ")}: merge ${ws.branch} into your branch, resolve inside your claim, push, and get the new commit approved`],
			};
		}

		// The project's checks, on main with the change merged in: what main would become.
		const verify = input.verify ?? [];
		const checksFrom = Date.now();
		let onto = ws;
		let tested: { base: string; after: string[] } | undefined;
		// Tell the line this result is done with: landed, or not (merges checked on top of it can't land as checked).
		let lineDone: ((landed: boolean, commit?: string) => Promise<void>) | undefined;
		const doneWithLine = async (landed: boolean, commit?: string) => {
			await lineDone?.(landed, commit).catch(() => undefined);
			lineDone = undefined;
		};
		if (verify.length) {
			if (!input.runChecks) throw new Error("[500] checks are configured but nothing can run them");
			const checked = await input.runChecks({ change: input.change, base: main, branch: ws.branch, head, ref: `changes/${input.change}`, commands: verify, source: input.source, agent: input.agent });
			if (!checked.passed) {
				const failed = checked.results.find((r) => r.exitCode !== 0);
				return { ok: false, reasons: [failed ? `checks failed: ${failed.command} exited ${failed.exitCode}` : "checks failed"], checks: checked.results };
			}
			lineDone = checked.done;
			tested = { base: checked.base ?? main, after: (checked.after ?? []).map((a) => a.head) };
			// Tested on another main, or after merges ahead in line: land right after those, on exactly the code tested.
			if (tested.base !== main || tested.after.length) {
				const turn = await awaitTurn(input, tested, checked.inLine);
				if (!turn) {
					await doneWithLine(false);
					continue;
				}
				onto = turn;
				await onto.fetch("change", input.source ?? input.remote, `changes/${input.change}`);
			}
		}

		const base = await onto.head();
		const claimed = {
			base,
			head,
			change: input.change,
			author: input.agent,
			by: input.stamper?.by,
			claimsTip: input.store.cite(view, scoped, own),
			votesTip: input.votes.cite(votes, head),
			testedOn: tested?.base,
			...(tested?.after.length ? { testedAfter: tested.after } : {}),
		};
		const message = [
			`Merge ${input.change} by ${input.agent}`,
			"",
			`GitHive-Change: ${input.change}`,
			`${FORMAT_TRAILER}: ${RECORD_FORMAT}`,
			`GitHive-Agent: ${input.agent}`,
			`GitHive-Claims: ${claimed.claimsTip}`,
			`GitHive-Votes: ${claimed.votesTip}`,
			// Which main the checks passed on: the merge's first parent, if nothing moved.
			...(claimed.testedOn ? [`GitHive-Tested: ${claimed.testedOn}`] : []),
			// The merges ahead in line the checks merged in first: exactly these came between that main and this merge.
			...(claimed.testedAfter ? [`GitHive-Tested-After: ${claimed.testedAfter.join(" ")}`] : []),
			// Who asked for it, as Access verified them, and GitHive's stamp over all of the above.
			...(input.stamper ? [`GitHive-By: ${input.stamper.by}`, `GitHive-Stamp: ${await input.stamper.stamp(mergeStampPayload(claimed))}`] : []),
			"",
		].join("\n");
		// Always a merge commit, never a fast-forward: the merge's trailers are what the audit reads.
		const { oid } = await git.merge({ fs: onto.fs, dir: "/repo", ours: onto.branch, theirs: head, message, author: BOT, fastForward: false, abortOnConflict: true });
		if (!oid) throw new Error(`merging ${input.change} made no commit`);
		try {
			await onto.push();
		} catch (err) {
			await doneWithLine(false);
			if (!(err instanceof git.Errors.PushRejectedError || err instanceof git.Errors.GitPushError)) throw err;
			// Main moved under us: another agent merged first. Check again on top of it, a few times.
			if (attempt < ATTEMPTS) continue;
			return { ok: false, reasons: [`the project's branch kept moving while ${input.change} merged (other merges landed first): merge again`] };
		}
		await doneWithLine(true, oid);
		const releaseFrom = Date.now();
		await input.store.release({ change: input.change, agent: input.agent, reason: "merged", mergedAs: oid }, input.stamper);
		console.log(`merged ${input.change} as ${oid.slice(0, 8)}: checks and push ${releaseFrom - checksFrom} ms, releasing its claim ${Date.now() - releaseFrom} ms`);
		return { ok: true, commit: oid };
	}
}

/**
 * Wait until the project's branch is `tested.base` followed by merges of
 * exactly `tested.after`, in order: then a merge onto it lands on the code its
 * checks ran on. Returns a checkout of that main, or null if main went another
 * way (a merge outside the line, or one ahead that never landed in time),
 * or the merge lost its place in line (`inLine`: one ahead left it): then
 * the merge checks again.
 */
/** The branch's head: as kept for every merge watching it, or listed. */
const headOf = (input: MergeInput) => (input.branchHead ? input.branchHead() : branchHead(input.remote, input.branch));

const fail409 = (message: string): never => {
	throw new Error(`[409] ${message}`);
};

async function awaitTurn(input: MergeInput, tested: { base: string; after: string[] }, inLine?: () => Promise<boolean>): Promise<Workspace | null> {
	const until = Date.now() + (input.turnWaitMs ?? TURN_WAIT_MS);
	for (let seen: string | null = null; ; await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS))) {
		if (inLine && !(await inLine().catch(() => true))) return null;
		const now = await headOf(input);
		if (now && now !== seen) {
			seen = now;
			const ws = await Workspace.at(input.remote, input.branch, now);
			const landed = await landedSince(ws, await ws.head(), tested.base, tested.after.length);
			if (!landed || landed.some((head, i) => head !== tested.after[i])) return null;
			if (landed.length === tested.after.length) return ws;
		}
		if (Date.now() > until) return null;
	}
}

/** The changes merged on the branch from `base` to `head`, oldest first (their merges' second parents), if it's at most `most` merges; else null. */
export async function landedSince(ws: Workspace, head: string, base: string, most: number): Promise<string[] | null> {
	const heads: string[] = [];
	for (let at = head; ; ) {
		if (at === base) return heads.reverse();
		if (heads.length === most) return null;
		const { commit } = await ws.ensureCommit(at);
		if (commit.parent.length < 2) return null;
		heads.push(commit.parent[1]);
		at = commit.parent[0];
	}
}
