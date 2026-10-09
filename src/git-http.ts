import base from "isomorphic-git/http/web";
import type { Remote } from "./git";

// isomorphic-git's HTTP client, with one change: a Git server's error (5xx)
// names the repo it came from, so a failure under load says which Git server
// it was (the project, a records repo, an agent's fork). Its status stays on
// the error, so retryTransient still treats it as transient.

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
 * run, in next and merge). onAuth stays, should a server ask anyway.
 */
export function gitAuth(remote: Remote) {
	const password = remote.token.split("?expires=")[0];
	return { headers: { Authorization: `Basic ${btoa(`x:${password}`)}` }, onAuth: () => ({ username: "x", password }) };
}

/** A response's body, read to the end now (its connection freed), and given back to be read again. */
async function drained(body: AsyncIterableIterator<Uint8Array> | undefined) {
	const chunks: Uint8Array[] = [];
	if (body) for await (const chunk of body) chunks.push(chunk);
	return (async function* () {
		yield* chunks;
	})();
}

export const http = {
	async request(request: Request) {
		const response = await base.request(request);
		// A failure's body is read now: left for later (a 401 asked again, a 5xx thrown), it holds a connection open.
		if (response.statusCode >= 400) response.body = await drained(response.body);
		if (response.statusCode >= 500)
			throw Object.assign(new Error(`HTTP Error: ${response.statusCode} ${response.statusMessage} (${repoOfUrl(request.url)})`), { status: response.statusCode });
		return response;
	},
};
