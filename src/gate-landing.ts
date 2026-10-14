// How the repo's own Gate reads, lands and pushes a batch's changes, once its container has the project's branch
// fetched. A change's Gate never runs these, because it ran that change's code.
import { WORKDIR, clip, gitWithToken, run } from "./container";
import { addPacks, checkoutDetached, fetchChanges, fetchMissing, missingCommits, requireBase } from "./gate-git";
import type { BatchBase, BatchSource } from "./gate-types";
import { BOT } from "./git";
import { type MergeClaim, mergeMessage } from "./toolkit/merge-commit";
import { type Stamper, makeStamper } from "./toolkit/stamp";

/** A push refused because the repo is busy is retried this many times, with growing waits. */
const PUSH_TRIES = 8;
const PUSH_RETRY_MS = 1_500;

/** Whether a push was refused only because the repo was busy with another one. */
export const pushBusy = (output: string) => /receive_pack_busy|repository is busy|try again later/i.test(output);

export type ReadChange = { change: string; head: string; files: string[] } | { change: string; error: string };
export type LandingMerge = BatchSource & { head: string; claimed: Omit<MergeClaim, "base"> };
/** A change that didn't merge onto the batch, and the files it conflicted on, where git listed them. */
export type LandingConflict = { change: string; files: string[] };
export type LandingResult = { commits: string[] } | { moved: true } | { error: string; conflict?: LandingConflict };
/** The batch merged for checks on Actions, or why it couldn't be: with the change that didn't merge and its files. */
export type ChecksResult = { tip: string } | { failed: string; conflict?: LandingConflict };
export type ChecksChange = { change: string; remote: string; token: string; ref: string; head: string };
export type ChecksBranch = {
	changes: ChecksChange[];
	to: { remote: string; token: string; user?: string };
	ref: string;
};
export type LandedPush = { head: string; to: { remote: string; token: string; user?: string }; as?: string };

/** Readies the container's checkout for a batch on `baseHead`, with the project's branch fetched. */
export async function fetchBatchBase(container: Container, input: BatchBase) {
	// Disable hooks, and commit as GitHive because a container has no git identity of its own.
	await run(container, [
		"bash",
		"-c",
		`git config core.hooksPath /dev/null && git config user.name "${BOT.name}" && git config ` +
			`user.email "${BOT.email}"`,
	]);
	// The container usually has the base already: the last batch it landed, or its fetch for the batch's checks.
	const has = () => run(container, ["git", "cat-file", "-e", `${input.baseHead}^{commit}`]);
	if ((await has()).exitCode === 0) return;
	await requireBase(container, input.base, input.branch);
	if ((await has()).exitCode !== 0) throw new Error(`${input.branch} at ${input.baseHead} isn't in the project`);
}

/** Fetches each change's branch and reads its current head and the files it changed since it left `baseHead`. */
export async function readChanges(
	container: Container,
	baseHead: string,
	changes: BatchSource[],
): Promise<ReadChange[]> {
	const failed = await fetchChanges(
		container,
		changes.map((source, k) => ({ k, ...source })),
	);
	const fetched = changes.map((_, index) => index).filter((index) => !failed.has(index));
	const listed = await listChangedFiles(container, baseHead, fetched);
	return changes.map((source, index) => {
		const read = listed.get(index);
		if (read) return { change: source.change, ...read };
		const error = failed.has(index)
			? `fetch of its branch failed: ${failed.get(index)}`
			: "its branch couldn't be read";
		return { change: source.change, error };
	});
}

/** The head and changed files of each fetched change, by its index in the batch. */
async function listChangedFiles(container: Container, baseHead: string, fetched: number[]) {
	// One command lists each change's head and its changed files. NUL separators let any file name through.
	const script = fetched
		.map(
			(index) =>
				`if h=$(git rev-parse refs/remotes/batch-${index}/head) && b=$(git merge-base ${baseHead} ` +
				`"$h"); then printf '%s %s\\0' ${index} "$h"; git diff --name-only --no-renames -z "$b" ` +
				`"$h"; else printf '%s -\\0' ${index}; fi; printf '\\0'`,
		)
		.join("\n");
	const listed = new Map<number, { head: string; files: string[] }>();
	if (!fetched.length) return listed;
	const ran = await run(container, ["bash", "-c", script]);
	for (const record of ran.output.split("\0\0").filter(Boolean)) {
		const [first = "", ...files] = record.split("\0");
		const [index, head] = first.split(" ");
		if (head && head !== "-") listed.set(Number(index), { head, files: files.filter(Boolean) });
	}
	return listed;
}

/**
 * Merges each change onto `baseHead` as its own merge commit and pushes them all at once, so the branch is never
 * partway through a batch. Returns `moved` if the branch is no longer at `baseHead`.
 */
export async function landMerges(
	container: Container,
	input: BatchBase & { merges: LandingMerge[]; by?: string },
	stampKey: string | undefined,
	keptPacks?: KeptPacks,
): Promise<LandingResult> {
	const steps = stepTimer();
	const kept = await addKeptPacks(container, input.merges, keptPacks);
	// Only the commits still missing are fetched.
	const failed = await fetchMissing(container, input.merges);
	steps.mark(`fetched (${kept} from kept packs)`);
	for (const [index, why] of failed) return { error: `fetch of ${input.merges[index]?.change} failed: ${why}` };
	const absent = await absentChanges(container, input.merges);
	if (absent) return { error: `not on their branches: ${absent.split("\n").join(", ")}` };
	await checkoutDetached(container, input.baseHead);
	steps.mark("checked out");
	const stamper = stampKey && input.by ? await makeStamper(stampKey, input.by) : undefined;
	const commits: string[] = [];
	let base = input.baseHead;
	for (const merge of input.merges) {
		const committed = await commitMerge(container, merge, base, stamper);
		if ("error" in committed) return committed;
		base = committed.commit;
		commits.push(base);
	}
	steps.mark("merged");
	const pushed = await pushWithLease(container, input);
	steps.mark("pushed");
	console.log(`gate landing of ${input.merges.length}: ${steps.done()}`);
	if (pushed.exitCode === 0) return { commits };
	// A server error can come after the push applied, so the branch decides, as tree landing does: at the last merge
	// it landed, and landing it again would merge every change twice.
	if ((await remoteHead(container, input)) === base) return { commits };
	if (/rejected|non-fast-forward|fetch first|stale info/i.test(pushed.output)) return { moved: true };
	return { error: `the push failed: ${clip(pushed.output, 500)}` };
}

/** Where the project's branch points on the server now, or null if it can't be read. */
async function remoteHead(container: Container, input: BatchBase) {
	const listed = await gitWithToken(container, input.base.token, [
		"ls-remote",
		input.base.remote,
		`refs/heads/${input.branch}`,
	]);
	if (listed.exitCode !== 0) return null;
	return listed.output.split(/\s/)[0] || null;
}

/** The packs merges fetched for their changes while they waited, by change head (see tree-landing.ts). */
export type KeptPacks = (heads: string[]) => Promise<Record<string, Uint8Array>>;

// Adds the packs kept for the changes the container doesn't have, sparing it a fetch from each fork. Returns how
// many changes they covered.
async function addKeptPacks(container: Container, merges: LandingMerge[], keptPacks: KeptPacks | undefined) {
	if (!keptPacks) return 0;
	const missing = (
		await missingCommits(
			container,
			merges.map((merge) => merge.head),
		)
	).map((k) => merges[k]!.head);
	if (!missing.length) return 0;
	const packs = await keptPacks(missing).catch((err) => {
		console.error("reading the kept packs failed", String(err));
		return {};
	});
	const found = Object.values(packs);
	return (await addPacks(container, found)) ? found.length : 0;
}

/** Each step's time since the one before, for the batch's log line. */
function stepTimer() {
	const started = Date.now();
	let last = started;
	const steps: string[] = [];
	return {
		mark: (step: string) => {
			steps.push(`${step} ${Date.now() - last} ms`);
			last = Date.now();
		},
		done: () => `${steps.join(", ")} (${Date.now() - started} ms)`,
	};
}

/** The changes whose heads the container doesn't have, one per line. */
async function absentChanges(container: Container, merges: LandingMerge[]) {
	const absent = await run(container, [
		"bash",
		"-c",
		merges.map((merge) => `git cat-file -e ${merge.head}^{commit} 2>/dev/null || echo ${merge.change}`).join("\n"),
	]);
	return absent.output.trim();
}

/**
 * Merges one change onto the checkout at `base` and commits it with its claim's trailers, in one command. Returns
 * the commit, or why it failed.
 */
async function commitMerge(
	container: Container,
	merge: LandingMerge,
	base: string,
	stamper: Stamper | undefined,
): Promise<{ commit: string } | { error: string; conflict?: LandingConflict }> {
	const identity = `-c user.name="${BOT.name}" -c user.email="${BOT.email}"`;
	// Always a merge commit, never a fast-forward, because the audit reads the merge's trailers. The conflicted files
	// are listed between two markers, so the Worker can name who changed them. A head already in the batch's history
	// has nothing to merge, which git merge won't commit, so its merge is written as it is: the tree unchanged, the
	// head its second parent, as tree landing writes it.
	const merged =
		`git merge -q --no-ff --no-commit ${merge.head} ${MERGE_OR_LIST}\n` +
		`git ${identity} commit -q --no-verify -F - >/tmp/commit.out 2>&1 || { cat /tmp/commit.out; exit 2; }\n`;
	const alreadyIn =
		`commit=$(git ${identity} commit-tree "HEAD^{tree}" -p HEAD -p ${merge.head} -F - 2>/tmp/commit.out) ` +
		"|| { cat /tmp/commit.out; exit 2; }\n" +
		'git reset -q --hard "$commit"\n';
	const script =
		`if git merge-base --is-ancestor ${merge.head} HEAD; then\n${alreadyIn}else\n${merged}fi\n` + "git rev-parse HEAD";
	const message = await mergeMessage({ ...merge.claimed, base }, stamper);
	const ran = await run(container, ["bash", "-c", script], WORKDIR, message);
	// Exit 1 is git merge failing, which names the change even when it listed no files (see conflictIn in
	// merge-land.ts): a failed commit or push isn't a conflict, and says nothing of one.
	if (ran.exitCode === 1) {
		const { files, output } = conflictListed(ran.output);
		return {
			error: `merging ${merge.change} onto the batch failed: ${clip(output, 500)}`,
			conflict: { change: merge.change, files },
		};
	}
	if (ran.exitCode !== 0) return { error: `committing ${merge.change}'s merge failed: ${clip(ran.output, 500)}` };
	return { commit: ran.output.trim() };
}

// The output of a merge that failed, with the conflicted files it listed between CONFLICT and CONFLICT-END taken out.
function conflictListed(output: string) {
	const [, listed = "", said = ""] = output.match(/^CONFLICT\n([\s\S]*?)CONFLICT-END\n([\s\S]*)$/) ?? [];
	const files = listed.split("\n").filter(Boolean);
	return { files, output: listed || said ? `${listed}${said}` : output.replace(/^CONFLICT\n/, "") };
}

// A merge that lists the files it conflicted on between two markers, then gives up, so the Worker can name them.
const MERGE_OR_LIST =
	">/tmp/merge.out 2>&1 || { echo CONFLICT; git -c core.quotePath=false diff --name-only --diff-filter=U; " +
	"echo CONFLICT-END; cat /tmp/merge.out; git merge --abort; exit 1; }";

/**
 * Pushes the checkout to the project's branch only if the branch is still exactly at the base. A plain push would
 * accept a fast-forward, which a change branched from a newer main could produce.
 */
async function pushWithLease(container: Container, input: BatchBase) {
	const push = () =>
		gitWithToken(container, input.base.token, [
			"push",
			"-q",
			`--force-with-lease=refs/heads/${input.branch}:${input.baseHead}`,
			input.base.remote,
			`HEAD:refs/heads/${input.branch}`,
		]);
	// Artifacts refuses a push while the repo takes another one, so a busy refusal is retried.
	let pushed = await push();
	for (let attempt = 1; pushed.exitCode !== 0 && pushBusy(pushed.output) && attempt < PUSH_TRIES; attempt++) {
		const jitter = 0.75 + Math.random() / 2;
		const wait = PUSH_RETRY_MS * 1.6 ** attempt * jitter;
		await new Promise((resolve) => setTimeout(resolve, wait));
		pushed = await push();
	}
	return pushed;
}

/**
 * Merges a batch onto `baseHead` as it will land and force-pushes it to `ref` on a connected GitHub repo, whose
 * Actions check it.
 */
export async function pushForChecks(container: Container, input: BatchBase & ChecksBranch): Promise<ChecksResult> {
	const failed = await fetchMissing(container, input.changes);
	for (const [index, why] of failed) return { failed: `fetch of ${input.changes[index]?.change} failed: ${why}` };
	await checkoutDetached(container, input.baseHead);
	for (const change of input.changes) {
		const merged = await run(container, [
			"bash",
			"-c",
			`git merge -q --no-ff -m "Check ${change.change} with the batch" ${change.head} ${MERGE_OR_LIST}`,
		]);
		if (merged.exitCode !== 0) {
			const { files, output } = conflictListed(merged.output);
			return {
				failed: `${change.change} doesn't merge onto the batch: ${clip(output, 500)}`,
				...(files.length ? { conflict: { change: change.change, files } } : {}),
			};
		}
	}
	const tip = (await run(container, ["git", "rev-parse", "HEAD"])).output.trim();
	const pushed = await gitWithToken(
		container,
		input.to.token,
		["push", "-q", "--force", input.to.remote, `HEAD:refs/heads/${input.ref}`],
		WORKDIR,
		input.to.user,
	);
	if (pushed.exitCode !== 0) return { failed: `the push to ${input.ref} failed: ${clip(pushed.output, 500)}` };
	return { tip };
}

/**
 * Pushes `branch` at `head` to a connected GitHub repo, as `as` when given (githive/main, for the pull request). The
 * push is a fast-forward only, so commits someone pushed there directly are never overwritten.
 */
export async function pushLanded(
	container: Container,
	input: { branch: string } & LandedPush,
): Promise<{ pushed: true } | { refused: string }> {
	const pushed = await gitWithToken(
		container,
		input.to.token,
		["push", "-q", input.to.remote, `${input.head}:refs/heads/${input.as ?? input.branch}`],
		WORKDIR,
		input.to.user,
	);
	return pushed.exitCode === 0 ? { pushed: true } : { refused: clip(pushed.output, 500) };
}
