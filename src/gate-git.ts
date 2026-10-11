// The git steps every Gate runs in its container: fetching the project's branch and a batch's changes, and checking
// out a commit. Each takes the container and keeps no state of its own.
import { WORKDIR, clip, gitWithToken, run } from "./container";
import { Chunks, joinPacks, streamOf } from "./git-pack";

/** How many of a batch's forks are fetched at once. Each fetch reads a different fork, so no one repo gets busier. */
const FETCHES_AT_ONCE = 16;

/** Fetches the project's `branch` into refs/remotes/base. */
export function fetchBase(container: Container, base: { remote: string; token: string }, branch: string) {
	return gitWithToken(container, base.token, [
		"fetch",
		"-q",
		base.remote,
		`${branch}:refs/remotes/base/${branch}`,
		"--force",
	]);
}

/** Fetches the project's `branch` into refs/remotes/base, throwing if it can't. */
export async function requireBase(container: Container, base: { remote: string; token: string }, branch: string) {
	const fetched = await fetchBase(container, base, branch);
	if (fetched.exitCode !== 0)
		throw new Error(`fetch of the project's ${branch} failed: ${clip(fetched.output, 2_000)}`);
}

/** A clean checkout of `commit`. Ignored files (node_modules) survive `git clean -fd`. */
export async function checkoutDetached(container: Container, commit: string) {
	await run(container, [
		"bash",
		"-lc",
		`git merge --abort 2>/dev/null; git checkout -q -f --detach ${commit} && git clean -fdq`,
	]);
}

/** The indexes of the commits the container doesn't have. */
export async function missingCommits(container: Container, commits: string[]): Promise<number[]> {
	const missing = await run(container, [
		"bash",
		"-c",
		commits.map((commit, index) => `git cat-file -e ${commit}^{commit} 2>/dev/null || echo ${index}`).join("\n"),
	]);
	return missing.output.split("\n").filter(Boolean).map(Number);
}

/**
 * Adds the objects in `packs` to the container's repo, as one pack. Their deltas may be against objects the repo
 * already has, which `--fix-thin` copies in. Returns whether git took them.
 */
export async function addPacks(container: Container, packs: Uint8Array[]) {
	if (!packs.length) return true;
	const joined = joinPacks(packs.map((pack) => new Chunks([pack])));
	const added = await run(container, ["git", "index-pack", "--stdin", "--fix-thin"], WORKDIR, streamOf(joined));
	if (added.exitCode !== 0) console.error("adding the kept packs failed", clip(added.output, 300));
	return added.exitCode === 0;
}

/** Fetches the branches of the changes whose heads the container doesn't have. Returns the failures and why. */
export async function fetchMissing(
	container: Container,
	changes: { head: string; remote: string; token: string; ref: string }[],
): Promise<Map<number, string>> {
	const heads = changes.map((change) => change.head);
	const missing = await missingCommits(container, heads);
	return fetchChanges(
		container,
		missing.flatMap((k) => {
			const change = changes[k];
			return change ? [{ k, ...change }] : [];
		}),
	);
}

/**
 * Fetches each change's branch into refs/remotes/batch-<k>/head in one command, several at a time with three tries
 * each. Tokens go in on stdin rather than the command line. Returns the failures and why.
 */
export async function fetchChanges(
	container: Container,
	changes: { k: number; remote: string; token: string; ref: string }[],
): Promise<Map<number, string>> {
	if (!changes.length) return new Map();
	const script = [
		"fetch_one() {",
		"  for try in 1 2 3; do",
		'    if out=$(git -c gc.auto=0 -c "http.extraHeader=Authorization: Bearer $4" fetch -q ' +
			'--no-write-fetch-head "$2" "$3:refs/remotes/batch-$1/head" --force 2>&1); then return 0; fi',
		"    sleep $((try * 2))",
		"  done",
		'  printf "%s %s\\n" "$1" "$(printf %s "$out" | tr "\\n" " " | cut -c1-300)" > "/tmp/batch-failed-$1"',
		"}",
		"rm -f /tmp/batch-failed-*",
		"while IFS=$'\\t' read -r k remote ref token; do",
		'  fetch_one "$k" "$remote" "$ref" "$token" &',
		`  while [ "$(jobs -rp | wc -l)" -ge ${FETCHES_AT_ONCE} ]; do wait -n; done`,
		"done",
		"wait",
		"cat /tmp/batch-failed-* 2>/dev/null; rm -f /tmp/batch-failed-*; true",
	].join("\n");
	const lines = changes.map((change) => {
		const token = change.token.split("?expires=")[0];
		return [change.k, change.remote, change.ref, token].join("\t");
	});
	const stdin = lines.join("\n") + "\n";
	const ran = await run(container, ["bash", "-c", script], WORKDIR, stdin);
	const failed = new Map<number, string>();
	for (const line of ran.output.split("\n").filter(Boolean)) {
		const space = line.indexOf(" ");
		const index = Number(line.slice(0, space));
		if (Number.isInteger(index)) failed.set(index, line.slice(space + 1));
	}
	if (ran.exitCode !== 0 && !failed.size) for (const change of changes) failed.set(change.k, clip(ran.output, 300));
	return failed;
}
