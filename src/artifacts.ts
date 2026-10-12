import type { Remote } from "./git";
import { noteArtifactsCall } from "./git-http";
import { BLOB_TOO_LARGE, type HistorySource } from "./toolkit/branch-history";
import { isTransientFailure, jitteredDelay, retryTransient, sleep, transientDelay } from "./retry";
import { rpc } from "./rpc";

/** One reviewer per slice, role and commit, so a new commit never collides with a reviewer still finishing. */
export const reviewerName = (sliceRepo: string, role: string, head: string) =>
	`${sliceRepo}--review-${role}--${head.slice(0, 12)}`;

/** Make an Artifacts call and count it (see countingRequests). The repo "-" means the namespace. */
async function call<T>(method: string, repo: string, operation: () => PromiseLike<T>): Promise<T> {
	try {
		const value = await operation();
		noteArtifactsCall(method, repo, false);
		return value;
	} catch (err) {
		noteArtifactsCall(method, repo, true);
		throw err;
	}
}

/** Run work against a disposable repo handle, releasing it even on failure. */
async function withRepo<T>(
	artifacts: Artifacts,
	name: string,
	operation: (repo: ArtifactsRepo) => Promise<T>,
	{ retry = true, retrying = retryArtifacts } = {},
): Promise<T> {
	const get = () => call("get", name, () => artifacts.get(name));
	const repo = await (retry ? retrying(get) : get()).catch((err) => Promise.reject(naming(err, name)));
	try {
		return await operation(repo);
	} catch (err) {
		throw naming(err, name);
	} finally {
		// The binding's handles must be disposed; test doubles may not have a dispose method.
		const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose;
		if (disposeSymbol) {
			const dispose = (repo as unknown as Record<symbol, unknown>)[disposeSymbol];
			if (typeof dispose === "function") dispose.call(repo);
		}
	}
}

/** Add the repo name to an Artifacts error, keeping its code and status for retries. */
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
			retryArtifacts(() => call("info", name, () => rpc(repo.info()))),
			retryArtifacts(() => call("createToken", name, () => rpc(repo.createToken(scope, ttlSeconds)))),
		]);
		return { url: info.remote, token: token.plaintext };
	});
}

/**
 * Read a repo's history through the Artifacts API rather than Git, retrying transient failures, and a busy repo's
 * INTERNAL_ERROR too unless `whenBusy` is "give up".
 */
export async function withHistory<T>(
	artifacts: Artifacts,
	name: string,
	read: (source: HistorySource) => Promise<T>,
	{ whenBusy = "retry" }: { whenBusy?: "retry" | "give up" } = {},
): Promise<T> {
	const retrying = whenBusy === "retry" ? retryArtifacts : retryUnlessBusy;
	return withRepo(
		artifacts,
		name,
		(repo) =>
			read({
				log: (ref, limit, offset) => retrying(() => call("log", name, () => rpc(repo.log({ ref, limit, offset })))),
				readCommit: (hash) => retrying(() => call("readCommit", name, () => rpc(repo.readCommit(hash)))),
				readTree: (hash) => retrying(() => call("readTree", name, () => rpc(repo.readTree(hash)))),
				readBlob: (hash, maxBytes) => retrying(() => call("readBlob", name, () => blobBytes(repo, hash, maxBytes))),
			}),
		{ retrying },
	);
}

// A blob over `maxBytes` is answered by its size alone, so its bytes are never copied into the isolate's heap.
async function blobBytes(repo: ArtifactsRepo, hash: string, maxBytes = Infinity) {
	const blob = await rpc(repo.readBlob(hash));
	if (!blob) return null;
	if (blob.size > maxBytes) return BLOB_TOO_LARGE;
	return new Uint8Array(await blob.arrayBuffer());
}

/** The most a file served from a repo may weigh. */
const FILE_MOST = 10 * 1024 * 1024;

/**
 * A file's bytes at `ref` (a branch, tag or commit) through the Artifacts API, null if the ref or path has no file,
 * or "too big" past FILE_MOST.
 */
export async function fileAt(artifacts: Artifacts, name: string, ref: string, path: string) {
	return withRepo(artifacts, name, (repo) =>
		retryArtifacts(() =>
			call("readFile", name, async (): Promise<Uint8Array | null | "too big"> => {
				const blob = await rpc(repo.readFile({ ref, path }));
				if (!blob) return null;
				if (blob.size > FILE_MOST) return "too big";
				return new Uint8Array(await blob.arrayBuffer());
			}),
		),
	);
}

/** The branch a repo's HEAD names, which Artifacts' reads by ref don't take. */
export async function defaultBranchOf(artifacts: Artifacts, name: string) {
	return withRepo(artifacts, name, async (repo) => (await rpc(repo.info())).defaultBranch);
}

export async function headOf(artifacts: Artifacts, name: string, ref: string) {
	return withRepo(artifacts, name, async (repo) => {
		const [latest] = await retryTransient(() => call("log", name, () => rpc(repo.log({ ref, limit: 1 }))));
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
		const page = await retryTransient(() => call("list", "-", () => artifacts.list({ limit: 200, cursor })));
		names.push(...page.repos.map((r) => r.name));
		cursor = page.cursor;
	} while (cursor);
	return names;
}

const codeOf = (err: unknown) => (err && typeof err === "object" && "code" in err ? String(err.code) : "");

/** Artifacts throttles a busy repo with INTERNAL_ERROR, such as many forks at once; retrying succeeds. */
const isInternalError = (err: unknown) => codeOf(err) === "INTERNAL_ERROR";

/** Whether Artifacts answered that a repo is busy (INTERNAL_ERROR, its throttling). */
export const isArtifactsBusy = isInternalError;

/** Retries Artifacts calls for a few seconds, longer than the default, since a busy repo stays busy a while. */
const retryArtifacts = <T>(operation: () => Promise<T>) =>
	retryTransient(operation, {
		maxAttempts: 5,
		baseDelayMs: 300,
		maxDelayMs: 3_000,
		retryable: (err) => isTransientFailure(err) || isInternalError(err),
	});

/** Retries only network failures: a busy repo is left alone, for callers whose reads are only advice. */
const retryUnlessBusy = <T>(operation: () => Promise<T>) =>
	retryTransient(operation, { retryable: (err) => !isInternalError(err) && isTransientFailure(err) });

const alreadyExists = (err: unknown) =>
	/EXISTS/.test(codeOf(err)) || /already exists/i.test(err instanceof Error ? err.message : "");

/** Under load a new fork can briefly read as missing, which means it isn't ready yet. */
const notFoundYet = (err: unknown) =>
	/NOT_FOUND/.test(codeOf(err)) || /not found/i.test(err instanceof Error ? err.message : "");

const FORK_ATTEMPTS = 5;

/**
 * How long a new fork may read as missing before it's requested again, and the total wait.
 * Under a burst of forks, Artifacts accepts some forks that never appear.
 */
const FORK_LOST_MS = 8_000;
const FORK_READY_MS = 90_000;
/** How long a fork may stay "in progress" before it's treated as stuck, which Artifacts can do under a burst. */
const FORK_STUCK_MS = 45_000;

/** The fork wasn't ready in time; asking again later may find it made. */
export const isForkNotReady = (err: unknown) => codeOf(err) === "FORK_NOT_READY";

interface ForkOptions {
	/** Others may make the same fork at once, as with seeds, so an existing one is waited for. */
	shared?: boolean;
}

/** Request a fork. Returns null when it already exists because an earlier request succeeded after all. */
function requestFork(artifacts: Artifacts, source: string, name: string, description: string, again: boolean) {
	return withRepo(artifacts, source, async (repo) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await call("fork", source, () => rpc(repo.fork(name, { description, defaultBranchOnly: true })));
			} catch (err) {
				if ((again || attempt > 1) && alreadyExists(err)) return null;
				const internal = isInternalError(err);
				if ((!internal && !isTransientFailure(err)) || attempt === FORK_ATTEMPTS) throw err;
				// Jitter spreads out a burst of forks that hit internal errors together.
				if (internal) await scheduler.wait(jitteredDelay(attempt, 250, 4_000));
				else await sleep(transientDelay(attempt));
			}
		}
	});
}

/** Deleting a stuck fork often lets it finish at once. Otherwise it's gone and is requested again. */
async function deleteStuckFork(artifacts: Artifacts, name: string, forkingSince: number) {
	console.log(
		`fork ${name} still forking after ${Math.round((Date.now() - forkingSince) / 1000)}s: deleting it, ` +
			"so it finishes or is made again",
	);
	await call("delete", name, () => artifacts.delete(name)).catch((deleting) =>
		console.error(`deleting the stuck fork ${name} failed`, String(deleting)),
	);
}

/** Whether a repo still being made, or not yet visible, may become usable if waited for. */
const mayBecomeReady = (err: unknown) => isTransientFailure(err) || isForkPending(err) || notFoundYet(err);

/**
 * Fork `source` and wait until the fork is ready, since get() throws while a repo is still forking.
 * Under load Artifacts fails some forks or loses them, so they're requested again.
 */
export async function forkAndWait(
	artifacts: Artifacts,
	source: string,
	name: string,
	description: string,
	{ shared = false }: ForkOptions = {},
) {
	let forked = await requestFork(artifacts, source, name, description, shared);
	const started = Date.now();
	// A fork stuck "in progress" is deleted once.
	let forkingSince: number | undefined;
	let unstuck = false;
	// Jittered, so forks lost together aren't all asked for again together.
	const lostAfter = () => FORK_LOST_MS * (0.75 + Math.random() / 2);
	let askAgainAt = started + lostAfter();
	for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
		try {
			// No retry inside: this loop already waits out transient failures.
			await withRepo(artifacts, name, async () => undefined, { retry: false });
			if (forked) return forked;
			const remote = await remoteFor(artifacts, name, "write", 3 * 3600);
			return { name, remote: remote.url, token: remote.token };
		} catch (err) {
			if (!mayBecomeReady(err)) throw err;
			const pending = isForkPending(err);
			if (pending) forkingSince ??= Date.now();
			if (pending && !unstuck && Date.now() - (forkingSince ?? Date.now()) > FORK_STUCK_MS) {
				unstuck = true;
				await deleteStuckFork(artifacts, name, forkingSince!);
				askAgainAt = Date.now();
				continue;
			}
			if (notFoundYet(err) && Date.now() > askAgainAt && Date.now() - started < FORK_READY_MS) {
				forked = (await requestFork(artifacts, source, name, description, true)) ?? forked;
				askAgainAt = Date.now() + lostAfter();
				continue;
			}
			if (Date.now() - started > FORK_READY_MS)
				throw Object.assign(new Error(`fork ${name} not ready after ${FORK_READY_MS / 1000}s: ${err}`), {
					code: "FORK_NOT_READY",
				});
			await scheduler.wait(delay);
		}
	}
}

/** Make a repo unless it exists already, and wait until it can be used. */
export async function ensureRepo(artifacts: Artifacts, name: string, description: string) {
	await retryTransient(() => call("create", name, () => artifacts.create(name, { description }))).catch((err) => {
		if (!alreadyExists(err)) throw err;
	});
	const started = Date.now();
	for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
		try {
			return await withRepo(artifacts, name, async () => undefined, { retry: false });
		} catch (err) {
			if (!mayBecomeReady(err)) throw err;
			if (Date.now() - started > FORK_READY_MS)
				throw new Error(`repo ${name} not ready after ${FORK_READY_MS / 1000}s: ${err}`);
			await scheduler.wait(delay);
		}
	}
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The forks (fork--<id>--...) and claim shards (records--<id>--<n>) a repo leaves behind.
 * Names belonging to a longer repo id, like acme--web when deleting acme, are excluded.
 */
export function leftoversOf(id: string, names: string[]) {
	const isLongerRepo = (name: string) =>
		!name.startsWith("fork--") && !name.startsWith("records--") && name.startsWith(`${id}--`);
	const longerRepos = names.filter(isLongerRepo);
	const belongsToLongerRepo = (name: string, kind: "fork" | "records") =>
		longerRepos.some((other) => name.startsWith(`${kind}--${other}--`));
	const forkPattern = new RegExp(`^fork--${escapeRegex(id)}--.+$`);
	const shardPattern = new RegExp(`^records--${escapeRegex(id)}--\\d+$`);
	return {
		forks: names.filter((name) => forkPattern.test(name) && !belongsToLongerRepo(name, "fork")),
		shards: names.filter((name) => shardPattern.test(name) && !belongsToLongerRepo(name, "records")),
	};
}
