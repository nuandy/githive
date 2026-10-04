import type { Remote } from "./git";
import { isTransientFailure, retryTransient } from "./retry";

// Repo names encode the task (<taskId>--<slice>) so Artifacts events can be
// routed back to the task's Coordinator without a lookup table.
export const baseRepoName = (taskId: string) => `${taskId}--base`;
export const sliceRepoName = (taskId: string, sliceId: string) => `${taskId}--${sliceId}`;

/**
 * One reviewer instance per (slice, role, commit). A new commit never collides
 * with a reviewer that is still finishing on an older one.
 */
export const reviewerName = (sliceRepo: string, role: string, head: string) => `${sliceRepo}--review-${role}--${head.slice(0, 12)}`;

export function parseRepoName(name: string) {
	const match = /^([0-9a-f]{8})--([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(name);
	return match ? { taskId: match[1], slice: match[2] } : null;
}

/** Run work against a disposable repo capability, releasing it even on failure. */
async function withRepo<T>(artifacts: Artifacts, name: string, operation: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
	const repo = await retryTransient(() => artifacts.get(name));
	try {
		return await operation(repo);
	} finally {
		// The binding provides disposable handles; optional invocation also keeps
		// lightweight test doubles compatible with the same operation contract.
		const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose;
		if (disposeSymbol) {
			const dispose = (repo as unknown as Record<symbol, unknown>)[disposeSymbol];
			if (typeof dispose === "function") dispose.call(repo);
		}
	}
}

/** A short-lived Git credential for an existing repo. */
export async function remoteFor(
	artifacts: Artifacts,
	name: string,
	scope: "read" | "write" = "read",
	ttlSeconds = 600,
): Promise<Remote> {
	return withRepo(artifacts, name, async (repo) => {
		const [info, token] = await Promise.all([
			retryTransient(() => repo.info()),
			retryTransient(() => repo.createToken(scope, ttlSeconds)),
		]);
		return { url: info.remote, token: token.plaintext };
	});
}

/**
 * A file on a repo's ref with its Git blob id (the id `git rev-parse <ref>:<path>`
 * prints), or null when the file doesn't exist.
 */
export async function fileVersion(artifacts: Artifacts, name: string, path: string, ref = "main") {
	return withRepo(artifacts, name, async (repo) => {
		const blob = await retryTransient(() => repo.readFile({ ref, path }));
		if (!blob) return null;
		const bytes = new Uint8Array(await blob.arrayBuffer());
		return { id: await blobId(bytes), text: new TextDecoder().decode(bytes) };
	});
}

/** Git's id for a blob: SHA-1 over "blob <size>\0" and the content. */
export async function blobId(bytes: Uint8Array) {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const data = new Uint8Array(header.byteLength + bytes.byteLength);
	data.set(header);
	data.set(bytes, header.byteLength);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
	return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function headOf(artifacts: Artifacts, name: string, ref = "main") {
	return withRepo(artifacts, name, async (repo) => {
		const [latest] = await retryTransient(() => repo.log({ ref, limit: 1 }));
		return latest?.hash;
	});
}

function isForkPending(err: unknown) {
	if (!err || typeof err !== "object" || !("code" in err)) return false;
	return ["FORK_IN_PROGRESS", "CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS"].includes(String(err.code));
}

/** Every repo name in the namespace. Forks far outnumber projects, so this reads every page. */
export async function listRepoNames(artifacts: Artifacts) {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await retryTransient(() => artifacts.list({ limit: 200, cursor }));
		names.push(...page.repos.map((r) => r.name));
		cursor = page.cursor;
	} while (cursor);
	return names;
}

/** Delete every repo whose name starts with `prefix` (a task's forks: `<task>--…`). Returns the names deleted. */
export async function deleteReposWithPrefix(artifacts: Artifacts, prefix: string) {
	if (!/^[0-9a-f]{8}--$/.test(prefix)) throw new Error(`refusing to delete repos by prefix ${prefix}: not a task's fork prefix`);
	const names = (await listRepoNames(artifacts)).filter((name) => name.startsWith(prefix));
	for (const name of names) await retryTransient(() => artifacts.delete(name));
	return names;
}

const codeOf = (err: unknown) => (err && typeof err === "object" && "code" in err ? String(err.code) : "");

/** Artifacts fails some forks of one repo when many run at once (INTERNAL_ERROR, 10400); they succeed when tried again. */
const isInternalError = (err: unknown) => codeOf(err) === "INTERNAL_ERROR";

const alreadyExists = (err: unknown) => /EXISTS/.test(codeOf(err)) || /already exists/i.test(err instanceof Error ? err.message : "");

/** Under load a fork that was just made can briefly read as missing; while waiting for it, that means not ready yet. */
const notFoundYet = (err: unknown) => /NOT_FOUND/.test(codeOf(err)) || /not found/i.test(err instanceof Error ? err.message : "");

const FORK_ATTEMPTS = 5;

/** How long a new fork may read as missing before it is asked for again, and how long to wait for it in all. */
const FORK_LOST_MS = 8_000;
const FORK_READY_MS = 30_000;

/**
 * Fork `source` and wait until the fork is ready, since get() throws while a
 * repo is still forking. Under load Artifacts fails some forks outright, and
 * now and then accepts one that never appears; both are asked for again.
 */
export async function forkAndWait(artifacts: Artifacts, source: string, name: string, description: string) {
	/** Request the fork; null when it turns out to exist already (a failed or lost request made it after all). */
	const requestFork = (again: boolean) =>
		withRepo(artifacts, source, async (repo) => {
			for (let attempt = 1; ; attempt++) {
				try {
					return await retryTransient(() => repo.fork(name, { description, defaultBranchOnly: true }));
				} catch (err) {
					if ((again || attempt > 1) && alreadyExists(err)) return null;
					if (!isInternalError(err) || attempt === FORK_ATTEMPTS) throw err;
					// Back off with jitter, so a burst of forks spreads out.
					await scheduler.wait(Math.min(250 * 2 ** attempt, 4_000) * (0.5 + Math.random()));
				}
			}
		});

	let forked = await requestFork(false);
	let askedAgain = false;
	const started = Date.now();
	for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
		try {
			await withRepo(artifacts, name, async () => undefined);
			if (forked) return forked;
			const remote = await remoteFor(artifacts, name, "write", 3 * 3600);
			return { name, remote: remote.url, token: remote.token };
		} catch (err) {
			if (!isTransientFailure(err) && !isForkPending(err) && !notFoundYet(err)) throw err;
			if (notFoundYet(err) && !askedAgain && Date.now() - started > FORK_LOST_MS) {
				askedAgain = true;
				forked = (await requestFork(true)) ?? forked;
				continue;
			}
			if (Date.now() - started > FORK_READY_MS) throw new Error(`fork ${name} not ready after ${FORK_READY_MS / 1000}s: ${err}`);
			await scheduler.wait(delay);
		}
	}
}
