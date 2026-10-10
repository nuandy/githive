// How the repo's own Gate reads, lands and pushes a batch's changes, once its container has the project's branch
// fetched. A change's Gate never runs these, because it ran that change's code.
import { WORKDIR, clip, gitWithToken, run } from "./container";
import { checkoutDetached, fetchChanges, fetchMissing, requireBase } from "./gate-git";
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
export type LandingResult = { commits: string[] } | { moved: true } | { error: string };
export type ChecksChange = { change: string; remote: string; token: string; ref: string; head: string };
export type ChecksBranch = {
	changes: ChecksChange[];
	to: { remote: string; token: string; user?: string };
	ref: string;
};
export type LandedPush = { head: string; to: { remote: string; token: string; user?: string } };

/** Readies the container's checkout for a batch on `baseHead`, with the project's branch fetched. */
export async function fetchBatchBase(container: Container, input: BatchBase) {
	// Disable hooks, and commit as GitHive because a container has no git identity of its own.
	await run(container, [
		"bash",
		"-c",
		`git config core.hooksPath /dev/null && git config user.name "${BOT.name}" && git config user.email "${BOT.email}"`,
	]);
	await requireBase(container, input.base, input.branch);
	if ((await run(container, ["git", "cat-file", "-e", `${input.baseHead}^{commit}`])).exitCode !== 0)
		throw new Error(`${input.branch} at ${input.baseHead} isn't in the project`);
}

/** Fetches each change's branch and reads its current head and the files it changed since it left `baseHead`. */
export async function readChanges(
	container: Container,
	baseHead: string,
	changes: BatchSource[],
): Promise<ReadChange[]> {
	const failed = await fetchChanges(
		container,
		changes.map((c, k) => ({ k, ...c })),
	);
	const fetched = changes.map((_, k) => k).filter((k) => !failed.has(k));
	const listed = await listChangedFiles(container, baseHead, fetched);
	return changes.map((c, k) => {
		const read = listed.get(k);
		if (read) return { change: c.change, ...read };
		return {
			change: c.change,
			error: failed.has(k) ? `fetch of its branch failed: ${failed.get(k)}` : "its branch couldn't be read",
		};
	});
}

/** The head and changed files of each fetched change, by its index in the batch. */
async function listChangedFiles(container: Container, baseHead: string, fetched: number[]) {
	// One command lists each change's head and its changed files. NUL separators let any file name through.
	const script = fetched
		.map(
			(k) =>
				`if h=$(git rev-parse refs/remotes/batch-${k}/head) && b=$(git merge-base ${baseHead} "$h"); then printf '%s %s\\0' ${k} "$h"; git diff --name-only --no-renames -z "$b" "$h"; else printf '%s -\\0' ${k}; fi; printf '\\0'`,
		)
		.join("\n");
	const listed = new Map<number, { head: string; files: string[] }>();
	if (!fetched.length) return listed;
	const ran = await run(container, ["bash", "-c", script]);
	for (const record of ran.output.split("\0\0").filter(Boolean)) {
		const [first, ...files] = record.split("\0");
		const [k, head] = first.split(" ");
		if (head && head !== "-") listed.set(Number(k), { head, files: files.filter(Boolean) });
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
): Promise<LandingResult> {
	// inspectBatch usually fetched these already, so only missing commits are fetched.
	const failed = await fetchMissing(container, input.merges);
	for (const [k, why] of failed) return { error: `fetch of ${input.merges[k].change} failed: ${why}` };
	const absent = await absentChanges(container, input.merges);
	if (absent) return { error: `not on their branches: ${absent.split("\n").join(", ")}` };
	await checkoutDetached(container, input.baseHead);
	const stamper = stampKey && input.by ? await makeStamper(stampKey, input.by) : undefined;
	for (const merge of input.merges) {
		const error = await commitMerge(container, merge, stamper);
		if (error) return { error };
	}
	const commits = await firstParentCommits(container, input.baseHead);
	const pushed = await pushWithLease(container, input);
	if (pushed.exitCode !== 0)
		return /rejected|non-fast-forward|fetch first|stale info/i.test(pushed.output)
			? { moved: true }
			: { error: `the push failed: ${clip(pushed.output, 500)}` };
	return { commits };
}

/** The changes whose heads the container doesn't have, one per line. */
async function absentChanges(container: Container, merges: LandingMerge[]) {
	const absent = await run(container, [
		"bash",
		"-c",
		merges.map((m) => `git cat-file -e ${m.head}^{commit} 2>/dev/null || echo ${m.change}`).join("\n"),
	]);
	return absent.output.trim();
}

/** Merges one change onto the checkout and commits it with its claim's trailers. Returns why it failed, if it did. */
async function commitMerge(container: Container, merge: LandingMerge, stamper: Stamper | undefined) {
	const as = ["-c", `user.name=${BOT.name}`, "-c", `user.email=${BOT.email}`];
	// Print the merge's base (the commit before it), then merge without committing.
	const merged = await run(container, [
		"bash",
		"-c",
		`base=$(git rev-parse HEAD) && git merge -q --no-ff --no-commit ${merge.head} >/tmp/merge.out 2>&1 && echo "$base" || { echo CONFLICT; git diff --name-only --diff-filter=U; cat /tmp/merge.out; git merge --abort; exit 1; }`,
	]);
	const base = merged.output.trim();
	if (merged.exitCode !== 0)
		return `merging ${merge.change} onto the batch failed: ${clip(merged.output.replace(/^CONFLICT\n/, ""), 500)}`;
	// Always a merge commit, never a fast-forward, because the audit reads the merge's trailers.
	const committed = await run(
		container,
		["git", ...as, "commit", "-q", "--no-verify", "-F", "-"],
		WORKDIR,
		await mergeMessage({ ...merge.claimed, base }, stamper),
	);
	if (committed.exitCode !== 0) return `committing ${merge.change}'s merge failed: ${clip(committed.output, 500)}`;
	return undefined;
}

/** The commits on the checkout since `baseHead`, oldest first, without the merged branches' own commits. */
async function firstParentCommits(container: Container, baseHead: string) {
	const listed = await run(container, ["git", "rev-list", "--reverse", "--first-parent", `${baseHead}..HEAD`]);
	return listed.output.split("\n").filter(Boolean);
}

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
		await new Promise((resolve) => setTimeout(resolve, PUSH_RETRY_MS * 1.6 ** attempt * (0.75 + Math.random() / 2)));
		pushed = await push();
	}
	return pushed;
}

/**
 * Merges a batch onto `baseHead` as it will land and force-pushes it to `ref` on a connected GitHub repo, whose
 * Actions check it.
 */
export async function pushForChecks(
	container: Container,
	input: BatchBase & ChecksBranch,
): Promise<{ tip: string } | { failed: string }> {
	const failed = await fetchMissing(container, input.changes);
	for (const [k, why] of failed) return { failed: `fetch of ${input.changes[k].change} failed: ${why}` };
	await checkoutDetached(container, input.baseHead);
	for (const change of input.changes) {
		const merged = await run(container, [
			"bash",
			"-c",
			`git merge -q --no-ff -m "Check ${change.change} with the batch" ${change.head} >/tmp/merge.out 2>&1 || { git diff --name-only --diff-filter=U; cat /tmp/merge.out; git merge --abort; exit 1; }`,
		]);
		if (merged.exitCode !== 0)
			return { failed: `${change.change} doesn't merge onto the batch: ${clip(merged.output, 500)}` };
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
 * Pushes `branch` at `head` to a connected GitHub repo. The push is a fast-forward only, so commits someone pushed
 * there directly are never overwritten.
 */
export async function pushLanded(
	container: Container,
	input: { branch: string } & LandedPush,
): Promise<{ pushed: true } | { refused: string }> {
	const pushed = await gitWithToken(
		container,
		input.to.token,
		["push", "-q", input.to.remote, `${input.head}:refs/heads/${input.branch}`],
		WORKDIR,
		input.to.user,
	);
	return pushed.exitCode === 0 ? { pushed: true } : { refused: clip(pushed.output, 500) };
}
