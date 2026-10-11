import { branchHead, inWorkspaceTurn, Workspace } from "../git";
import { inLane } from "../claim-paths";
import { repoOfUrl } from "../git-http";
import { busyArtifacts, changeAgainst, landedOn } from "./batch-reads";
import { skipsChecks } from "./check-scope";
import type { ClaimRecord } from "./claims";
import type { ClaimsView } from "./claim-store";
import { conflictWords, type Landing, lastLandedOn, type Settled } from "./landing";
import { CHECKS_REVIEWER } from "./merge-checks";
import type { BatchSource, MergeInput, MergeOutcome, Ready, Refused } from "./merge-types";
import type { VotesView } from "./vote-store";
import { approval, countedVotes, effectivePolicy } from "./votes";
import { fail } from "../errors";

// A change about to be checked against its claim and votes, at the head and with the files just read.
type Proposed = BatchSource & { head: string; files: string[]; mine: boolean };

// A change as read against the branch: its head, its files, and whether it merges cleanly into `branch`.
interface ChangeRead {
	head: string;
	files: string[];
	tried: { clean: boolean; files?: string[] };
	branch: string;
}

export function conflict(message: string): never {
	fail(409, message);
}

// The branch's head, cached for every merge watching it, or else listed.
function headOf(input: MergeInput) {
	return input.branchHead ? input.branchHead() : branchHead(input.remote, input.branch);
}

export function outcomeOf(settled: Settled): MergeOutcome {
	if (settled.how === "landed") {
		const skipped = settled.skipped ? { checks: "skipped: it only touches files the checks skip" } : {};
		return { ok: true, commit: settled.commit!, ...skipped };
	}
	return {
		ok: false,
		reasons: settled.reasons ?? ["it didn't land"],
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
	// The records are read once the workspace is released.
	const { head, files, tried, branch } = await readChange(input, baseHead, ref);
	const ready = await validated(input, {
		change: input.change,
		agent: input.agent,
		ref,
		...(input.source ? { source: input.source } : {}),
		head,
		files,
		mine: true,
	});
	if (!ready.ok) return { ok: false, refused: ready, head };
	if (!tried.clean)
		return { ok: false, head, refused: await conflictRefusal(input, landing, tried.files ?? [], branch) };
	return ready;
}

// Reads the change through Artifacts' API where possible (see changeAgainst). If no file changed on both sides, the
// change merges cleanly and nothing is fetched. Otherwise git takes its turn in the isolate's workspace (see
// inWorkspaceTurn), which needs one listing and no clone.
async function readChange(input: MergeInput, baseHead: string, ref: string): Promise<ChangeRead> {
	const read = await readThroughHistory(input, baseHead, ref);
	if (read && !("error" in read) && !read.both.length)
		return { head: read.head, files: read.files, tried: { clean: true }, branch: input.branch };
	return inWorkspaceTurn(async () => {
		const workspace = await Workspace.at(input.remote, input.branch, baseHead);
		const head = await workspace.fetch("change", input.source ?? input.remote, ref);
		const files = await workspace.changedPaths(await workspace.mergeBase(baseHead, head), head);
		return { head, files, tried: await workspace.tryMerge(baseHead, head), branch: workspace.branch };
	});
}

async function readThroughHistory(input: MergeInput, baseHead: string, ref: string) {
	if (!input.history) return null;
	const target = { ref, ...(input.source ? { source: input.source } : {}) };
	const repo = repoOfUrl(input.remote.url);
	return changeAgainst(input.history, repo, input.branch, baseHead, target).catch((err) =>
		busyArtifacts(input.change, err),
	);
}

async function conflictRefusal(
	input: MergeInput,
	landing: Landing,
	conflicts: string[],
	branch: string,
): Promise<Refused> {
	// Name who last changed each file, so the agent knows what it's reconciling with and whom to ask.
	const recent = (await landing.view().catch(() => null))?.recent ?? [];
	const causes = lastLandedOn(recent, conflicts);
	const where = conflictWords(conflicts, causes).join(", ");
	return {
		ok: false,
		conflicts,
		...(causes.length ? { causes } : {}),
		reasons: [
			`changes/${input.change} conflicts with ${branch} in ${where}: merge ${branch} into your ` +
				"branch, resolve inside your claim, push, and get the new commit approved",
		],
	};
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
	const reasons = claimReasons(proposed, scoped, claims, own);
	reasons.push(...(await voteReasons(input, proposed, own, votes)));
	if (reasons.length || !own) return { ok: false, reasons };
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

// Approvals count distinct reviewers other than the author, under the policy for the files touched. That policy may
// be stricter for dependency, CI and deploy files.
function approvalReasons(
	input: MergeInput,
	head: string,
	own: ClaimRecord | undefined,
	counted: VotesView["votes"],
	files: string[],
): string[] {
	const outcome = approval({ votes: counted }, head, input.policy, own, files);
	const { required } = effectivePolicy(input.policy, files);
	if (outcome.vetoedBy.length) return [`${head} is vetoed by ${outcome.vetoedBy.join(", ")}`];
	if (outcome.approvals < required)
		return [`${head} has ${outcome.approvals} of ${required} approvals from reviewers other than its author`];
	if (outcome.awaiting.length)
		return [`${head} still needs approval from ${outcome.awaiting.join(", ")}, which can veto it`];
	return [];
}

function claimReasons(proposed: Proposed, scoped: string[], claims: ClaimsView, own?: ClaimRecord): string[] {
	const { change } = proposed;
	const reasons: string[] = [];
	if (!own) reasons.push(`${change} holds no claim`);
	proposed.files.forEach((file, index) => {
		// The file as the claims records name it (scoped to its branch); the same list, in the same order.
		const scopedFile = scoped[index] ?? file;
		const holder = claims.claims.find((claim) => claim.change !== change && inLane(scopedFile, claim.paths));
		if (holder) reasons.push(`${file} is inside ${holder.change}'s claim (${holder.agent})`);
		else if (own && !inLane(scopedFile, own.paths)) reasons.push(`${file} is outside ${change}'s claim`);
	});
	return reasons;
}

async function voteReasons(
	input: MergeInput,
	proposed: Proposed,
	own: ClaimRecord | undefined,
	votes: VotesView,
): Promise<string[]> {
	const { head, files } = proposed;
	const onHead = votes.votes.filter((vote) => vote.commit === head);
	const counted = await countedVotes(onHead, input.stampKey);
	const reasons: string[] = [];
	// GitHub's changes, while the repo trusts them, need no votes; only their checks can send them back.
	const trusted = !!own && !!(await input.trusted?.(own, head));
	if (!trusted) reasons.push(...approvalReasons(input, head, own, counted, files));
	// Its checks failed twice on this exact commit, so merging it again would fail. A new commit is checked afresh.
	const failed = counted.find((vote) => vote.reviewer === CHECKS_REVIEWER && vote.verdict === "reject");
	if (failed) reasons.push(`${failed.evidence.split("\n")[0]}: push a fix (a new commit) and get it approved`);
	else if (!proposed.mine && !trusted) {
		const author = own?.agent ?? proposed.agent;
		const sentBack = counted.find((vote) => vote.verdict === "reject" && vote.reviewer !== author);
		if (sentBack) reasons.push(`${sentBack.reviewer} asked for changes on ${head}`);
	}
	return reasons;
}
