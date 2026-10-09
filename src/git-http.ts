import base from "isomorphic-git/http/web";

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

export const http = {
	async request(request: Request) {
		const response = await base.request(request);
		if (response.statusCode >= 500)
			throw Object.assign(new Error(`HTTP Error: ${response.statusCode} ${response.statusMessage} (${repoOfUrl(request.url)})`), { status: response.statusCode });
		return response;
	},
};
