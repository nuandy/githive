import { branchHead, type Hunk, inWorkspaceTurn, Workspace } from "../git";
import { inLane } from "../claim-paths";
import { repoOfUrl } from "../git-http";
import { busyArtifacts, changeAgainst, landedOn, type TouchedBy, touchedInWorkspace } from "./batch-reads";
import { skipsChecks } from "./check-scope";
import type { ClaimRecord } from "./claims";
import type { ClaimsView } from "./claim-store";
import { conflictLine, conflictWords, type Landing, lastLandedOn, type Settled } from "./landing";
import { BATCH_MERGE, CHECKS_REVIEWER, rejectedFor } from "./merge-checks";
import type { BatchSource, MergeInput, MergeOutcome, Ready, Refused, Why } from "./merge-types";
import type { VotesView } from "./vote-store";
import { approval, countedVotes, effectivePolicy } from "./votes";
import { fail } from "../errors";
import { shellWord } from "../git-guidance";

// A change about to be checked against its claim and votes, at the head and with the files just read.
type Proposed = BatchSource & { head: string; files: string[]; mine: boolean };

// A change as read against the branch: its head, its files, and whether it merges cleanly into `branch`. A conflict
// comes with its files' markers and the branch's commits that changed them since the change left it.
export interface ChangeRead {
	head: string;
	files: string[];
	tried: { clean: boolean; files?: string[]; hunks?: Hunk[] };
	touchedBy?: TouchedBy[];
	branch: string;
}

export function conflict(message: string): never {
	fail(409, message);
}

// The branch's head, cached for every merge watching it, or else listed.
function headOf(input: MergeInput) {
	return input.branchHead ? input.branchHead() : branchHead(input.remote, input.branch);
}

/** A settled change as its merge's outcome. A failure is put out by putOut, for its checks or for a conflict. */
export function outcomeOf(settled: Settled, branch?: string): MergeOutcome {
	if (settled.how === "landed") {
		const skipped = settled.skipped ? { checks: "skipped: it only touches files the checks skip" } : {};
		return { ok: true, commit: settled.commit!, ...skipped };
	}
	const conflicts = settled.conflicts ?? [];
	const conflicted = conflicts.length > 0 || !!settled.checks?.some((check) => check.command === BATCH_MERGE);
	const into = branch ? { into: branch } : {};
	return {
		ok: false,
		reasons: settled.reasons ?? ["it didn't land"],
		why: [conflicted ? "conflict" : "checks"],
		...(conflicted ? { ...into, head: settled.head } : {}),
		...(conflicts.length ? { conflicts } : {}),
		...(settled.touchedBy?.length ? { touchedBy: settled.touchedBy } : {}),
		...(conflicts.length && branch ? { fix: conflictFix(branch, settled.change, conflicts) } : {}),
		...(settled.checks ? { checks: settled.checks } : {}),
	};
}

// This merge's change as it stands now, refused at once if it isn't ready so that the agent can act.
export async function readyNow(
	input: MergeInput,
	landing: Landing,
): Promise<{ ok: true; ready: Ready } | { ok: false; refused: Refused; head: string }> {
	const baseHead = (await headOf(input)) ?? conflict(`there's no branch ${input.branch}`);
	const ref = `changes/${input.change}`;
	const source = input.source ? { source: input.source } : {};
	// The records are read once the workspace is released.
	const read = await readChange(input, baseHead, { change: input.change, ref, ...source });
	const { head, files, tried, branch } = read;
	const ready = await validated(input, {
		change: input.change,
		agent: input.agent,
		ref,
		...source,
		head,
		files,
		mine: true,
	});
	if (tried.clean) return ready.ok ? ready : { ok: false, refused: ready, head };
	// A conflict is said with whatever else keeps it from landing, since resolving it needs a new commit anyway.
	const conflicts = { files: tried.files ?? [], hunks: tried.hunks, touchedBy: read.touchedBy ?? [] };
	const refused = { ...(await conflictRefusal(input, landing, conflicts, branch)), head };
	return { ok: false, head, refused: ready.ok ? refused : alsoRefused(refused, ready) };
}

// A conflict's refusal with another refusal's reasons, and what they're about, after its own.
function alsoRefused(conflicted: Refused, other: Refused): Refused {
	const { reasons, why, ...fields } = other;
	return {
		...fields,
		...conflicted,
		reasons: [...conflicted.reasons, ...reasons],
		why: [...new Set([...conflicted.why, ...why])],
	};
}

/**
 * Test-merges a change onto the branch at `baseHead`, reading it through Artifacts' API where possible (see
 * changeAgainst). If no file changed on both sides, it merges cleanly and nothing is fetched. Otherwise git takes its
 * turn in the isolate's workspace (see inWorkspaceTurn), which needs one listing and no clone. The conflict markers
 * show the change's side first, as `git merge origin/<branch>` does in the agent's clone.
 */
export async function readChange(
	input: MergeInput,
	baseHead: string,
	change: { change: string; ref: string; source?: MergeInput["source"] },
): Promise<ChangeRead> {
	const read = await readThroughHistory(input, baseHead, change);
	if (read && !("error" in read) && !read.both.length)
		return { head: read.head, files: read.files, tried: { clean: true }, branch: input.branch };
	return inWorkspaceTurn(async () => {
		const workspace = await Workspace.at(input.remote, input.branch, baseHead);
		const head = await workspace.fetch("change", change.source ?? input.remote, change.ref);
		const base = await workspace.mergeBase(baseHead, head);
		const files = await workspace.changedPaths(base, head);
		const labels = { ours: `ours (${change.ref})`, theirs: `origin/${input.branch}` };
		const tried = await workspace.tryMerge(head, baseHead, labels);
		if (tried.clean) return { head, files, tried, branch: workspace.branch };
		// Who changed the conflicted files since the change left the branch, from the history the workspace holds.
		const touchedBy = await touchedInWorkspace(workspace, baseHead, base, tried.files).catch((err) => {
			console.error(`reading who changed ${change.change}'s conflicted files failed`, String(err));
			return [];
		});
		return { head, files, tried, touchedBy, branch: workspace.branch };
	});
}

async function readThroughHistory(
	input: MergeInput,
	baseHead: string,
	change: { change: string; ref: string; source?: MergeInput["source"] },
) {
	if (!input.history) return null;
	const target = { ref: change.ref, ...(change.source ? { source: change.source } : {}) };
	const repo = repoOfUrl(input.remote.url);
	return changeAgainst(input.history, repo, input.branch, baseHead, target).catch((err) =>
		busyArtifacts(change.change, err),
	);
}

async function conflictRefusal(
	input: MergeInput,
	landing: Landing,
	conflict: { files: string[]; hunks?: Hunk[]; touchedBy: TouchedBy[] },
	branch: string,
): Promise<Refused> {
	const { files: conflicts, hunks, touchedBy } = conflict;
	// Name who last changed each file, so the agent knows what it's reconciling with and whom to ask.
	const recent = (await landing.view().catch(() => null))?.recent ?? [];
	const causes = lastLandedOn(recent, conflicts);
	const where = conflictWords(conflicts, causes, touchedBy).join(", ");
	// The merge commit's story tells of it once the change lands.
	await input
		.noteAttempt?.(input.change, conflictLine(conflicts, touchedBy, causes))
		.catch((err) => console.error(`noting ${input.change}'s conflict failed`, String(err)));
	return {
		ok: false,
		why: ["conflict"],
		into: branch,
		conflicts,
		...(causes.length ? { causes } : {}),
		...(touchedBy.length ? { touchedBy } : {}),
		...(hunks?.length ? { hunks } : {}),
		fix: conflictFix(branch, input.change, conflicts),
		reasons: [
			`changes/${input.change} conflicts with ${branch} in ${where}: merge ${branch} into your ` +
				"branch, resolve inside your claim, push, and get the new commit approved; see touchedBy, hunks and fix",
		],
	};
}

/**
 * The commands that resolve a conflict with `branch` in the clone credentials gives, where the project is `origin`
 * and the agent's fork is `fork`; then what to call. Merging the branch in stops at the conflict, for the agent to
 * resolve so that both changes make sense.
 */
export function conflictFix(branch: string, change: string, files: string[]): string[] {
	const named = files.map(shellWord).join(" ");
	const from = shellWord(`origin/${branch}`);
	return [
		`git fetch origin ${shellWord(branch)} && git merge ${from}`,
		`# resolve ${named} so both changes make sense, then:`,
		`git add ${named} && git commit --no-edit`,
		`git push fork ${shellWord(`changes/${change}`)}`,
		"call status; once the new commit is approved, merge again",
	];
}

// The outcome if the change already landed at `head`, since its claim is gone by then. The landing's recent outcomes
// answer first; failing that, the branch's history, as a merge commit whose second parent is `head`.
export async function landedAlready(input: MergeInput, landing: Landing, head: string): Promise<MergeOutcome | null> {
	const recent = (await landing.view().catch(() => null))?.recent;
	const landed = recent?.findLast(
		(settled) => settled.change === input.change && settled.how === "landed" && settled.head === head,
	);
	if (landed) return outcomeOf(landed);
	if (!input.history) return null;
	const baseHead = await headOf(input).catch(() => null);
	if (!baseHead) return null;
	const repo = repoOfUrl(input.remote.url);
	const merges = await landedOn(input.history, repo, input.branch, baseHead, [head]).catch(() => null);
	const commit = merges?.get(head);
	return commit ? { ok: true, commit } : null;
}

// Whether a change may land: its claim covers every file and no one else's does, its head has the approvals, and its
// checks haven't failed on that head. Another agent's change is also held back if a reviewer asked for changes.
// Only the records are read here; the batch finds out whether it merges cleanly.
/** The files as the claims records name them, which differs for a branch other than the project's. */
export const scopedFiles = (input: MergeInput, files: string[]) => (input.scope ? files.map(input.scope) : files);

export async function validated(
	input: MergeInput,
	proposed: Proposed,
	batch?: { votes: VotesView; claims: ClaimsView },
): Promise<{ ok: true; ready: Ready } | Refused> {
	const { head, files } = proposed;
	const scoped = scopedFiles(input, files);
	// The claims bearing on these files, and the votes on its head (read once for the whole batch when given).
	const [claims, votes] = await Promise.all([
		batch?.claims ?? input.store.readScope(proposed.change, scoped),
		batch?.votes ?? input.votes.readFor([head]),
	]);
	const own = claims.claims.find((claim) => claim.change === proposed.change);
	const refusal: Refused = { ok: false, reasons: [], why: [] };
	claimReasons(refusal, proposed, scoped, claims, own);
	await voteReasons(refusal, input, proposed, own, votes);
	if (refusal.reasons.length || !own) return refusal;
	// No checks for a change that only touches what they skip, such as documentation (see check-scope.ts).
	const skipped = !!input.verify?.length && skipsChecks(files, input.skipChecks);
	return {
		ok: true,
		ready: {
			change: proposed.change,
			agent: proposed.agent,
			head,
			ref: proposed.ref,
			...(proposed.source ? { source: proposed.source } : {}),
			files,
			scoped,
			claims,
			own,
			votes,
			skipped,
		},
	};
}

/** Adds a reason to a refusal being made, with what it's about (see Why). */
function refuse(refusal: Refused, why: Why, reason: string) {
	refusal.reasons.push(reason);
	if (!refusal.why.includes(why)) refusal.why.push(why);
}

// Approvals count distinct reviewers other than the author, under the policy for the files touched. That policy may
// be stricter for dependency, CI and deploy files.
function approvalRefusals(
	refusal: Refused,
	input: MergeInput,
	head: string,
	own: ClaimRecord | undefined,
	counted: VotesView["votes"],
	files: string[],
): void {
	const outcome = approval({ votes: counted }, head, input.policy, own, files);
	const { required } = effectivePolicy(input.policy, files);
	if (outcome.vetoedBy.length) refuse(refusal, "changes-asked", `${head} is vetoed by ${outcome.vetoedBy.join(", ")}`);
	else if (outcome.approvals < required)
		refuse(
			refusal,
			"approvals",
			`${head} has ${outcome.approvals} of ${required} approvals from reviewers other than its author`,
		);
	else if (outcome.awaiting.length)
		refuse(refusal, "approvals", `${head} still needs approval from ${outcome.awaiting.join(", ")}, which can veto it`);
}

function claimReasons(
	refusal: Refused,
	proposed: Proposed,
	scoped: string[],
	claims: ClaimsView,
	own?: ClaimRecord,
): void {
	const { change } = proposed;
	if (!own) refuse(refusal, "unclaimed", `${change} holds no claim`);
	proposed.files.forEach((file, index) => {
		// The file as the claims records name it (scoped to its branch); the same list, in the same order.
		const scopedFile = scoped[index] ?? file;
		const holder = claims.claims.find((claim) => claim.change !== change && inLane(scopedFile, claim.paths));
		if (holder) {
			refuse(refusal, "inside", `${file} is inside ${holder.change}'s claim (${holder.agent})`);
			(refusal.insideOthers ??= []).push(file);
		} else if (own && !inLane(scopedFile, own.paths)) {
			refuse(refusal, "outside", `${file} is outside ${change}'s claim`);
			(refusal.outsideClaim ??= []).push(file);
		}
	});
}

async function voteReasons(
	refusal: Refused,
	input: MergeInput,
	proposed: Proposed,
	own: ClaimRecord | undefined,
	votes: VotesView,
): Promise<void> {
	const { head, files } = proposed;
	const onHead = votes.votes.filter((vote) => vote.commit === head);
	const counted = await countedVotes(onHead, input.stampKey);
	// GitHub's changes, while the repo trusts them, need no votes; only their checks can send them back.
	const trusted = !!own && !!(await input.trusted?.(own, head));
	if (!trusted) approvalRefusals(refusal, input, head, own, counted, files);
	// Its checks failed on this exact commit, or it didn't merge, so merging it again would fail. A new commit is
	// checked afresh.
	const failed = counted.find((vote) => vote.reviewer === CHECKS_REVIEWER && vote.verdict === "reject");
	if (failed) {
		const said = rejectedFor(failed.evidence);
		refuse(refusal, said.why, `${failed.evidence.split("\n")[0]}: push a fix (a new commit) and get it approved`);
		if (said.why === "conflict") refusal.into = input.branch;
		else if (said.check) refusal.checks = [said.check];
	} else if (!proposed.mine && !trusted) {
		const author = own?.agent ?? proposed.agent;
		const sentBack = counted.find((vote) => vote.verdict === "reject" && vote.reviewer !== author);
		if (sentBack) refuse(refusal, "changes-asked", `${sentBack.reviewer} asked for changes on ${head}`);
	}
}
