import { AsyncLocalStorage } from "node:async_hooks";
import base from "isomorphic-git/http/web";
import type { Remote } from "./git";

// isomorphic-git's HTTP client, adapted for Artifacts. Server errors (5xx) are retried for a few
// seconds, because Artifacts answers 500 while a repo is busy, and a final failure names the repo.
// Every request is also counted by repo for the call that made it.

type Request = Parameters<typeof base.request>[0];

/** The repo a Git URL is for: the segment ending in .git, or the one before info/refs or git-upload-pack. */
export function repoOfUrl(url: string) {
	const segments = new URL(url).pathname.split("/").filter(Boolean);
	const repoSegment = segments.find((segment) => segment.endsWith(".git"));
	if (repoSegment) return repoSegment.slice(0, -4);
	const protocol = segments.findIndex((segment) => segment === "info" || segment.startsWith("git-"));
	return segments[protocol > 0 ? protocol - 1 : segments.length - 1] ?? url;
}

/**
 * Credentials for an isomorphic-git call, sent with the first request. With only onAuth, each request
 * first gets a 401 whose unread body holds one of the Worker's 6 connections, and parallel reads stall.
 */
export function gitAuth(remote: Remote) {
	const password = remote.token.split("?expires=")[0];
	const username = remote.user ?? "x";
	return {
		headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
		onAuth: () => ({ username, password }),
	};
}

/** Read a response body to the end, freeing its connection, and return it to be read again. */
async function drained(body: AsyncIterableIterator<Uint8Array> | undefined) {
	const chunks: Uint8Array[] = [];
	if (body) for await (const chunk of body) chunks.push(chunk);
	return replay(chunks);
}

/** A response body that yields `chunks` again. */
function replay(chunks: Uint8Array[]) {
	return (async function* () {
		yield* chunks;
	})();
}

/** Every chunk of a response body, read to the end. */
async function bodyChunks(body: AsyncIterableIterator<Uint8Array> | undefined) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of (await drained(body)) as AsyncIterable<Uint8Array>) chunks.push(chunk);
	return chunks;
}

export type GitRequests = Map<string, { requests: number; failed: number }>;
/** Artifacts binding calls (not Git requests), keyed by "<method> <repo>". */
export type ArtifactsCalls = Map<string, { calls: number; failed: number }>;
const counted = new AsyncLocalStorage<{ git: GitRequests; artifacts: ArtifactsCalls }>();

/** Run `work`, counting the Git requests and Artifacts calls it makes. */
export function countingRequests<T>(work: () => Promise<T>): {
	done: Promise<T>;
	requests: GitRequests;
	artifacts: ArtifactsCalls;
} {
	const requests: GitRequests = new Map();
	const artifacts: ArtifactsCalls = new Map();
	return { done: counted.run({ git: requests, artifacts }, work), requests, artifacts };
}

export function noteGitRequest(url: string, status: number) {
	const requests = counted.getStore()?.git;
	if (!requests) return;
	const repo = repoOfUrl(url);
	const seen = requests.get(repo) ?? { requests: 0, failed: 0 };
	requests.set(repo, { requests: seen.requests + 1, failed: seen.failed + (status >= 500 ? 1 : 0) });
}

/** Count an Artifacts call. Calls on the namespace itself use the repo name "-". */
export function noteArtifactsCall(method: string, repo: string, failed: boolean) {
	const calls = counted.getStore()?.artifacts;
	if (!calls) return;
	const key = `${method} ${repo}`;
	const seen = calls.get(key) ?? { calls: 0, failed: 0 };
	calls.set(key, { calls: seen.calls + 1, failed: seen.failed + (failed ? 1 : 0) });
}

/** The kind of repo a name is, for counts. With no `project` given, any unrecognized name counts as the project. */
export function repoKind(name: string, project: string | undefined) {
	if (name.startsWith("records--")) return "records";
	if (name.startsWith("fork--")) return "forks";
	if (name === "-") return "namespace";
	return project === undefined || name === project ? "project" : "other";
}

/** Counts as one log line, such as "git: project 4, forks 2 (1 failed); artifacts 3: get 3 (project 2, records 1)". */
export function describeCounts(project: string | undefined, git: GitRequests, artifacts: ArtifactsCalls) {
	const parts: string[] = [];
	if (git.size) parts.push(`git: ${describeGitRequests(project, git)}`);
	if (artifacts.size) parts.push(describeArtifactsCalls(project, artifacts));
	return parts.join("; ");
}

/** Git requests summed by kind of repo, such as "project 4, forks 2 (1 failed)". */
function describeGitRequests(project: string | undefined, git: GitRequests) {
	const kinds = new Map<string, { requests: number; failed: number }>();
	for (const [name, seen] of git) {
		const kind = repoKind(name, project);
		const sum = kinds.get(kind) ?? { requests: 0, failed: 0 };
		kinds.set(kind, { requests: sum.requests + seen.requests, failed: sum.failed + seen.failed });
	}
	const described = [...kinds].map(([kind, sum]) => {
		const failed = sum.failed ? ` (${sum.failed} failed)` : "";
		return `${kind} ${sum.requests}${failed}`;
	});
	return described.join(", ");
}

/** Artifacts calls summed by method, such as "artifacts 3: get 3 (project 2, records 1)". */
function describeArtifactsCalls(project: string | undefined, artifacts: ArtifactsCalls) {
	const methods = new Map<string, { calls: number; failed: number; kinds: Map<string, number> }>();
	for (const [key, seen] of artifacts) {
		const space = key.indexOf(" ");
		const method = key.slice(0, space);
		const kind = repoKind(key.slice(space + 1), project);
		const sum = methods.get(method) ?? { calls: 0, failed: 0, kinds: new Map<string, number>() };
		sum.calls += seen.calls;
		sum.failed += seen.failed;
		sum.kinds.set(kind, (sum.kinds.get(kind) ?? 0) + seen.calls);
		methods.set(method, sum);
	}
	const total = [...methods.values()].reduce((calls, sum) => calls + sum.calls, 0);
	const described = [...methods].map(([method, sum]) => {
		const kinds = [...sum.kinds].map(([kind, calls]) => `${kind} ${calls}`).join(", ");
		const failed = sum.failed ? `; ${sum.failed} failed` : "";
		return `${method} ${sum.calls} (${kinds}${failed})`;
	});
	return `artifacts ${total}: ${described.join(", ")}`;
}

/**
 * Attempts for a Git request that fails with a 5xx, with doubling backoff over about 6 s.
 * A busy Artifacts repo keeps failing for longer than a short burst of retries.
 * The final error is marked as retried so callers don't retry again (see isTransientFailure).
 */
const GIT_TRIES = 5;
const GIT_RETRY_MS = 400;

/**
 * How long a Git request may go unanswered before it's treated as a server failure (504) and retried.
 * A busy repo can accept a request and never answer it. Tests lower the limit.
 */
export const gitTimeout = { ms: 45_000 };

const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** fetch for a Git request, returning a 504 if it goes unanswered for gitTimeout.ms. */
export async function gitFetch(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(gitTimeout.ms) });
	} catch (err) {
		if (timedOut(err)) return new Response(`no answer in ${gitTimeout.ms / 1000} s`, { status: 504 });
		throw err;
	}
}

type GitResponse = Awaited<ReturnType<typeof base.request>>;

export const http = {
	async request(request: Request) {
		// Collect the body once so it can be sent again. The client doesn't stream uploads anyway.
		const body = request.body ? [await collected(request.body)] : undefined;
		for (let attempt = 1; ; attempt++) {
			const response = await requestOnce(request, body);
			if (request.url.endsWith("/git-upload-pack") && response.statusCode === 200) await failEmptyFetch(response);
			noteGitRequest(request.url, response.statusCode);
			// Read a failure's body now; left unread, it holds a connection open.
			if (response.statusCode >= 400) response.body = await drained(response.body);
			else if (request.url.endsWith("/git-receive-pack")) await refuseBusyPush(request.url, response);
			if (response.statusCode < 500) return response;
			if (attempt < GIT_TRIES) {
				const jitter = 0.5 + Math.random();
				await new Promise((resolve) => setTimeout(resolve, GIT_RETRY_MS * 2 ** (attempt - 1) * jitter));
				continue;
			}
			throw Object.assign(
				new Error(
					`HTTP Error: ${response.statusCode} ${response.statusMessage} (${repoOfUrl(request.url)}, ${GIT_TRIES} tries)`,
				),
				{ status: response.statusCode, retried: true },
			);
		}
	},
};

/** One try of a Git request. A request that goes unanswered for gitTimeout.ms comes back as a 504. */
function requestOnce(request: Request, body: Uint8Array[] | undefined): Promise<GitResponse> {
	const withBody = body ? { ...request, body: body as never } : request;
	return base.request({ ...withBody, signal: AbortSignal.timeout(gitTimeout.ms) }).catch((err) => {
		if (!timedOut(err)) throw err;
		return {
			url: request.url,
			method: request.method,
			statusCode: 504,
			statusMessage: `no answer in ${gitTimeout.ms / 1000} s`,
			headers: {},
			body: undefined,
		} as unknown as GitResponse;
	});
}

/**
 * A busy Artifacts repo sometimes answers a fetch with 200 and an empty body, which git rejects
 * ("expected 'packfile'"). A real answer is never empty, so this marks it as a server failure.
 */
async function failEmptyFetch(response: GitResponse) {
	const chunks = await bodyChunks(response.body);
	if (!chunks.some((chunk) => chunk.length))
		Object.assign(response, { statusCode: 502, statusMessage: "empty answer to a fetch" });
	else response.body = replay(chunks);
}

/**
 * Artifacts refuses a push while the repo takes another, with an ERR line isomorphic-git can't parse
 * ("Expected unpack ok"). This throws for it so the pusher can retry.
 */
async function refuseBusyPush(url: string, response: GitResponse) {
	const chunks = await bodyChunks(response.body);
	const bytes = chunks.length === 1 ? chunks[0] : await new Blob(chunks).arrayBuffer();
	if (/receive_pack_busy/.test(new TextDecoder().decode(bytes)))
		throw Object.assign(
			new Error(`push refused: ${repoOfUrl(url)} is busy with another (artifacts_git_receive_pack_busy)`),
			{ code: "RECEIVE_PACK_BUSY" },
		);
	response.body = replay(chunks);
}

async function collected(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of body) chunks.push(chunk);
	const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		all.set(chunk, at);
		at += chunk.length;
	}
	return all;
}
