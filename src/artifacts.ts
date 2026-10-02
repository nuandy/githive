import type { Remote } from "./git";

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

/** A short-lived Git credential for an existing repo. */
export async function remoteFor(
	artifacts: Artifacts,
	name: string,
	scope: "read" | "write" = "read",
	ttlSeconds = 600,
): Promise<Remote> {
	using repo = await artifacts.get(name);
	const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, ttlSeconds)]);
	return { url: info.remote, token: token.plaintext };
}

export async function headOf(artifacts: Artifacts, name: string, ref = "main") {
	using repo = await artifacts.get(name);
	const [latest] = await repo.log({ ref, limit: 1 });
	return latest?.hash;
}

/** Fork `source` and wait until the fork is ready, since get() throws while a repo is still forking. */
export async function forkAndWait(artifacts: Artifacts, source: string, name: string, description: string) {
	let forked: ArtifactsCreateRepoResult;
	{
		using repo = await artifacts.get(source);
		forked = await repo.fork(name, { description, defaultBranchOnly: true });
	}
	const deadline = Date.now() + 20_000;
	for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
		try {
			using _ready = await artifacts.get(name);
			return forked;
		} catch (err) {
			if (Date.now() > deadline) throw new Error(`fork ${name} not ready after 20s: ${err}`);
			await scheduler.wait(delay);
		}
	}
}
