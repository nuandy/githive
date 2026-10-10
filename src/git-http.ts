import { AsyncLocalStorage } from "node:async_hooks";
import base from "isomorphic-git/http/web";
import type { Remote } from "./git";

// isomorphic-git's HTTP client, with these changes: a Git server's error (5xx)
// is tried again for a few seconds (Artifacts answers 500 while a repo is
// busy), then names the repo it came from, so a failure under load says which
// Git server it was (the project, a records repo, an agent's fork); and every
// request is counted by repo, for the call it's made in (see gitRequests).

type Request = Parameters<typeof base.request>[0];

/** The repo a Git URL is for: the path segment ending in .git, or the one before the protocol's own (info/refs, git-upload-pack...). */
export function repoOfUrl(url: string) {
	const path = new URL(url).pathname.split("/").filter(Boolean);
	const git = path.find((p) => p.endsWith(".git"));
	if (git) return git.slice(0, -4);
	const protocol = path.findIndex((p) => p === "info" || p.startsWith("git-"));
	return path[protocol > 0 ? protocol - 1 : path.length - 1] ?? url;
}

/**
 * Credentials for an isomorphic-git call to `remote`, sent with the first
 * request. With only onAuth, it asks without them, gets a 401, and asks
 * again, leaving the 401's body unread: a Worker request holds 6 connections
 * open, and with a few reads side by side those held them all, so the
 * runtime cancelled responses to break the stall (2,585 times in a 200-agent
 * run, in next (now reviews and backlog) and merge). onAuth stays, should a server ask anyway.
 */
export function gitAuth(remote: Remote) {
	const password = remote.token.split("?expires=")[0];
	const username = remote.user ?? "x";
	return { headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` }, onAuth: () => ({ username, password }) };
}

/** A response's body, read to the end now (its connection freed), and given back to be read again. */
async function drained(body: AsyncIterableIterator<Uint8Array> | undefined) {
	const chunks: Uint8Array[] = [];
	if (body) for await (const chunk of body) chunks.push(chunk);
	return (async function* () {
		yield* chunks;
	})();
}

/** Git requests by repo, and how many failed (5xx), for the call they're made in. */
export type GitRequests = Map<string, { requests: number; failed: number }>;
const counted = new AsyncLocalStorage<GitRequests>();

/** Run `work`, counting the Git requests it makes by repo (see noteGitRequest). */
export function countingGitRequests<T>(work: () => Promise<T>): { done: Promise<T>; requests: GitRequests } {
	const requests: GitRequests = new Map();
	return { done: counted.run(requests, work), requests };
}

/** Count a Git request to `url` (and whether the server failed it) for the call it's made in, if any is counting. */
export function noteGitRequest(url: string, status: number) {
	const requests = counted.getStore();
	if (!requests) return;
	const repo = repoOfUrl(url);
	const seen = requests.get(repo) ?? { requests: 0, failed: 0 };
	requests.set(repo, { requests: seen.requests + 1, failed: seen.failed + (status >= 500 ? 1 : 0) });
}

/**
 * How many times a Git request a server failed (5xx) is made in all, each
 * wait twice the last (from GIT_RETRY_MS, with jitter): about 6 s, where a
 * busy Artifacts repo's 500s outlasted the few tries in half a second that
 * callers made, and reached agents. Given up on, the error says so, and no
 * caller tries it again (see isTransientFailure).
 */
const GIT_TRIES = 5;
const GIT_RETRY_MS = 400;

export const http = {
	async request(request: Request) {
		// Collected once, to send again (the client collects it anyway: no streaming uploads).
		const body = request.body ? [await collected(request.body)] : undefined;
		for (let attempt = 1; ; attempt++) {
			const response = await base.request({ ...request, ...(body ? { body: body as never } : {}) });
			noteGitRequest(request.url, response.statusCode);
			// A failure's body is read now: left for later (a 401 asked again, a 5xx thrown), it holds a connection open.
			if (response.statusCode >= 400) response.body = await drained(response.body);
			// A push's answer, small, read now: Artifacts refuses one while the repo takes another with an ERR line that
			// isomorphic-git can't read ("Expected unpack ok"), so it's said here, for the pusher to try again.
			else if (request.url.endsWith("/git-receive-pack")) {
				const chunks: Uint8Array[] = [];
				for await (const chunk of (await drained(response.body)) as AsyncIterable<Uint8Array>) chunks.push(chunk);
				if (/receive_pack_busy/.test(new TextDecoder().decode(chunks.length === 1 ? chunks[0] : await new Blob(chunks).arrayBuffer())))
					throw Object.assign(new Error(`push refused: ${repoOfUrl(request.url)} is busy with another (artifacts_git_receive_pack_busy)`), { code: "RECEIVE_PACK_BUSY" });
				response.body = (async function* () {
					yield* chunks;
				})();
			}
			if (response.statusCode < 500) return response;
			if (attempt < GIT_TRIES) {
				await new Promise((resolve) => setTimeout(resolve, GIT_RETRY_MS * 2 ** (attempt - 1) * (0.5 + Math.random())));
				continue;
			}
			throw Object.assign(new Error(`HTTP Error: ${response.statusCode} ${response.statusMessage} (${repoOfUrl(request.url)}, ${GIT_TRIES} tries)`), { status: response.statusCode, retried: true });
		}
	},
};

/** A request body as one array of bytes. */
async function collected(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of body) chunks.push(chunk);
	const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.length;
	}
	return all;
}
