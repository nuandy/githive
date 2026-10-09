import type { Remote } from "./git";
import { isTransientFailure, retryTransient, sleep, transientDelay } from "./retry";
import { rpc } from "./rpc";

/**
 * One reviewer instance per (slice, role, commit). A new commit never collides
 * with a reviewer that is still finishing on an older one.
 */
export const reviewerName = (sliceRepo: string, role: string, head: string) => `${sliceRepo}--review-${role}--${head.slice(0, 12)}`;

/**
 * Run work against a disposable repo capability, releasing it even on failure.
 * Getting the repo is retried when it fails transiently, unless `retry` is false
 * because the caller retries itself.
 */
async function withRepo<T>(artifacts: Artifacts, name: string, operation: (repo: ArtifactsRepo) => Promise<T>, { retry = true } = {}): Promise<T> {
	const repo = await (retry ? retryArtifacts(() => artifacts.get(name)) : artifacts.get(name)).catch((err) => Promise.reject(naming(err, name)));
	try {
		return await operation(repo);
	} catch (err) {
		throw naming(err, name);
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

/** An Artifacts failure, saying which repo it was about (its code and status kept, for retries). */
function naming(err: unknown, name: string) {
	if (err instanceof Error && !err.message.includes(`(${name})`)) err.message = `${err.message} (${name})`;
	return err;
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
			retryArtifacts(() => rpc(repo.info())),
			retryArtifacts(() => rpc(repo.createToken(scope, ttlSeconds))),
		]);
		return { url: info.remote, token: token.plaintext };
	});
}

export async function headOf(artifacts: Artifacts, name: string, ref: string) {
	return withRepo(artifacts, name, async (repo) => {
		const [latest] = await retryTransient(() => rpc(repo.log({ ref, limit: 1 })));
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

const codeOf = (err: unknown) => (err && typeof err === "object" && "code" in err ? String(err.code) : "");

/** Artifacts fails some forks of one repo when many run at once (INTERNAL_ERROR, 10400); they succeed when tried again. */
const isInternalError = (err: unknown) => codeOf(err) === "INTERNAL_ERROR";

/** Retry an Artifacts call through transient failures and the internal errors Artifacts returns under load. */
const retryArtifacts = <T>(operation: () => Promise<T>) => retryTransient(operation, { retryable: (err) => isTransientFailure(err) || isInternalError(err) });

const alreadyExists = (err: unknown) => /EXISTS/.test(codeOf(err)) || /already exists/i.test(err instanceof Error ? err.message : "");

/** Under load a fork that was just made can briefly read as missing; while waiting for it, that means not ready yet. */
const notFoundYet = (err: unknown) => /NOT_FOUND/.test(codeOf(err)) || /not found/i.test(err instanceof Error ? err.message : "");

const FORK_ATTEMPTS = 5;

/**
 * How long a new fork may read as missing before it is asked for again (and
 * again, each time it stays missing that long), and how long to wait for it
 * in all. Under a burst of forks, some accepted forks never appear.
 */
const FORK_LOST_MS = 8_000;
const FORK_READY_MS = 60_000;

/**
 * Fork `source` and wait until the fork is ready, since get() throws while a
 * repo is still forking. Under load Artifacts fails some forks outright, and
 * now and then accepts one that never appears; both are asked for again.
 * Each loop below does its own retrying, with no retry loop inside it, so a
 * fork is requested at most FORK_ATTEMPTS times per ask.
 */
export async function forkAndWait(artifacts: Artifacts, source: string, name: string, description: string, { shared = false }: { /** Others may be making the same fork at once (a seed): one that exists already is theirs, waited for. */ shared?: boolean } = {}) {
	/** Request the fork; null when it turns out to exist already (a failed or lost request made it after all). */
	const requestFork = (again: boolean) =>
		withRepo(artifacts, source, async (repo) => {
			for (let attempt = 1; ; attempt++) {
				try {
					return await rpc(repo.fork(name, { description, defaultBranchOnly: true }));
				} catch (err) {
					if ((again || attempt > 1) && alreadyExists(err)) return null;
					const internal = isInternalError(err);
					if ((!internal && !isTransientFailure(err)) || attempt === FORK_ATTEMPTS) throw err;
					// An internal error backs off with jitter, so a burst of forks spreads
					// out; a transient failure waits as retryTransient would.
					if (internal) await scheduler.wait(Math.min(250 * 2 ** attempt, 4_000) * (0.5 + Math.random()));
					else await sleep(transientDelay(attempt));
				}
			}
		});

	let forked = await requestFork(shared);
	const started = Date.now();
	// Jittered, so forks lost together aren't all asked for again together.
	const lostAfter = () => FORK_LOST_MS * (0.75 + Math.random() / 2);
	let askAgainAt = started + lostAfter();
	for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
		try {
			// One try: this loop already waits out transient failures.
			await withRepo(artifacts, name, async () => undefined, { retry: false });
			if (forked) return forked;
			const remote = await remoteFor(artifacts, name, "write", 3 * 3600);
			return { name, remote: remote.url, token: remote.token };
		} catch (err) {
			if (!isTransientFailure(err) && !isForkPending(err) && !notFoundYet(err)) throw err;
			if (notFoundYet(err) && Date.now() > askAgainAt && Date.now() - started < FORK_READY_MS) {
				forked = (await requestFork(true)) ?? forked;
				askAgainAt = Date.now() + lostAfter();
				continue;
			}
			if (Date.now() - started > FORK_READY_MS) throw new Error(`fork ${name} not ready after ${FORK_READY_MS / 1000}s: ${err}`);
			await scheduler.wait(delay);
		}
	}
}

/** Make a repo unless it exists already, and wait until it can be used. */
export async function ensureRepo(artifacts: Artifacts, name: string, description: string) {
	await retryTransient(() => artifacts.create(name, { description })).catch((err) => {
		if (!alreadyExists(err)) throw err;
	});
	const started = Date.now();
	for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
		try {
			return await withRepo(artifacts, name, async () => undefined, { retry: false });
		} catch (err) {
			if (!isTransientFailure(err) && !isForkPending(err) && !notFoundYet(err)) throw err;
			if (Date.now() - started > FORK_READY_MS) throw new Error(`repo ${name} not ready after ${FORK_READY_MS / 1000}s: ${err}`);
			await scheduler.wait(delay);
		}
	}
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a repo leaves behind besides itself: its agents' forks
 * (fork--<id>--agent--<agent>, and fork--<id>--<change> from before forks
 * were per agent) and its claim shards (records--<id>--<n>). A name that
 * belongs to a longer repo id (acme--web, when deleting acme) is never one of
 * them, whatever it looks like.
 */
export function leftoversOf(id: string, names: string[]) {
	const longer = names.filter((n) => !n.startsWith("fork--") && !n.startsWith("records--") && n.startsWith(`${id}--`));
	const theirs = (name: string, kind: "fork" | "records") => longer.some((other) => name.startsWith(`${kind}--${other}--`));
	const fork = new RegExp(`^fork--${escapeRegex(id)}--.+$`);
	const shard = new RegExp(`^records--${escapeRegex(id)}--\\d+$`);
	return {
		forks: names.filter((n) => fork.test(n) && !theirs(n, "fork")),
		shards: names.filter((n) => shard.test(n) && !theirs(n, "records")),
	};
}

