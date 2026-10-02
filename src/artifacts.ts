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

/** Fork `source` and wait until the fork is ready, since get() throws while a repo is still forking. */
export async function forkAndWait(artifacts: Artifacts, source: string, name: string, description: string) {
	const forked = await withRepo(artifacts, source, (repo) =>
		retryTransient(() => repo.fork(name, { description, defaultBranchOnly: true })),
	);
	const deadline = Date.now() + 20_000;
	for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
		try {
			await withRepo(artifacts, name, async () => undefined);
			return forked;
		} catch (err) {
			if (!isTransientFailure(err) && !isForkPending(err)) throw err;
			if (Date.now() > deadline) throw new Error(`fork ${name} not ready after 20s: ${err}`);
			await scheduler.wait(delay);
		}
	}
}
