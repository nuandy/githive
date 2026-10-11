import type { Remote } from "./git";

// GitHive's GitHub App, used to push main to a connected GitHub repo after each landing (its main, or githive/main
// for the standing pull request), to read where GitHub's branch is, to open that pull request, and to run checks on
// GitHub Actions. GitHive signs a short JWT with the App's key and exchanges it for an installation token scoped to
// the repo. The App's ID and its PKCS#8 private key are Worker secrets.

const API = "https://api.github.com";
const HEADERS = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "githive",
};

export interface WorkflowRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	url: string;
}

/** A pull request as GitHive reads it. */
export interface PullRequest {
	number: number;
	url: string;
	title: string;
	body: string;
	/** The branch it takes, in the same repo. */
	head: string;
	/** The branch it goes into. */
	base: string;
}

/** A GitHub repo GitHive may write to, with its git remote and the REST calls GitHive uses. */
export interface GitHubLink {
	repo: string;
	remote: Remote;
	runsFor(sha: string): Promise<WorkflowRun[]>;
	deleteBranch(name: string): Promise<void>;
	/** The repo's default branch and its head. `signal` gives up the read. */
	defaultHead(signal?: AbortSignal): Promise<{ branch: string; head: string }>;
	/** The open pull request from `head`, a branch of the repo, or null. `signal` gives up the read. */
	openPull(head: string, signal?: AbortSignal): Promise<PullRequest | null>;
	createPull(input: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
	updatePull(number: number, input: { title: string; body: string }): Promise<PullRequest>;
}

export interface GitHubApp {
	appId: string;
	privateKey: string;
}

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Calls GitHub's REST API with a JWT or an installation token. `signal` gives the call up. */
async function api<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<T> {
	const headers: Record<string, string> = { ...HEADERS, Authorization: `Bearer ${token}` };
	const init: RequestInit = { method, headers, ...(signal ? { signal } : {}) };
	if (body) {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	const response = await fetcher(`${API}${path}`, init);
	if (!response.ok)
		throw new GitHubError(
			response.status,
			`GitHub ${method} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`,
		);
	return (response.status === 204 ? undefined : await response.json()) as T;
}

const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
const encoder = new TextEncoder();

/** The App's JWT, valid for 9 minutes because GitHub allows at most 10, and backdated a minute for clock drift. */
export async function appJwt(app: GitHubApp, now = Date.now()) {
	const pem = app.privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(pem), (character) => character.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
		"sign",
	]);
	const seconds = Math.floor(now / 1000);
	const encodeJson = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
	const header = encodeJson({ alg: "RS256", typ: "JWT" });
	const claims = encodeJson({ iat: seconds - 60, exp: seconds + 540, iss: app.appId });
	const unsigned = `${header}.${claims}`;
	const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned)));
	return `${unsigned}.${base64url(signature)}`;
}

/**
 * Runs `run` for at most `ms`, then gives it up (its signal aborts) and throws. For GitHub reads in a request someone
 * waits on: GitHub's API can accept a connection and never answer.
 */
export async function withinMs<T>(ms: number, what: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const giveUp = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			giveUp.abort();
			reject(new Error(`${what} didn't answer within ${ms / 1000} s`));
		}, ms);
	});
	try {
		return await Promise.race([run(giveUp.signal), late]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Installation tokens by repo, reused until five minutes before they expire. */
const tokens = new Map<string, { token: string; until: number }>();

interface ApiPull {
	number: number;
	html_url: string;
	title: string;
	body: string | null;
	head: { ref: string };
	base: { ref: string };
}

const toPull = (pull: ApiPull): PullRequest => ({
	number: pull.number,
	url: pull.html_url,
	title: pull.title,
	body: pull.body ?? "",
	head: pull.head.ref,
	base: pull.base.ref,
});

/** Each repo's default branch, briefly: it rarely changes, and reading it would double every head read. */
const defaults = new Map<string, { branch: string; until: number }>();
const DEFAULT_KEPT_MS = 10 * 60_000;

/** The last answer to each branch read, by URL, with its ETag: a 304 costs nothing against GitHub's rate limit. */
const branchReads = new Map<string, { etag: string; head: string }>();

/** A branch's head through the REST API, asked with the last answer's ETag. */
async function branchHeadOf(token: string, repo: string, branch: string, fetcher: typeof fetch, signal?: AbortSignal) {
	const path = `/repos/${repo}/branches/${encodeURIComponent(branch)}`;
	const kept = branchReads.get(path);
	const headers: Record<string, string> = { ...HEADERS, Authorization: `Bearer ${token}` };
	if (kept) headers["If-None-Match"] = kept.etag;
	const response = await fetcher(`${API}${path}`, { headers, ...(signal ? { signal } : {}) });
	if (response.status === 304 && kept) return kept.head;
	if (!response.ok)
		throw new GitHubError(
			response.status,
			`GitHub GET ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`,
		);
	const head = ((await response.json()) as { commit: { sha: string } }).commit.sha;
	const etag = response.headers.get("ETag");
	if (etag) branchReads.set(path, { etag, head });
	return head;
}

interface ApiWorkflowRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	html_url: string;
}

function toWorkflowRun(run: ApiWorkflowRun): WorkflowRun {
	return { id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url };
}

/** A token for the App's installation on `repo`, from the cache while it's fresh. */
async function installationToken(app: GitHubApp, repo: string, fetcher: typeof fetch, signal?: AbortSignal) {
	const kept = tokens.get(repo);
	if (kept && kept.until > Date.now()) return kept.token;
	const jwt = await appJwt(app);
	const path = `/repos/${repo}/installation`;
	const installation = await api<{ id: number }>(jwt, "GET", path, undefined, fetcher, signal);
	const name = repo.split("/")[1];
	const issued = await api<{ token: string; expires_at: string }>(
		jwt,
		"POST",
		`/app/installations/${installation.id}/access_tokens`,
		{ repositories: [name] },
		fetcher,
		signal,
	);
	tokens.set(repo, { token: issued.token, until: Date.parse(issued.expires_at) - 5 * 60_000 });
	return issued.token;
}

/** A link to `repo` (owner/name) through the App, or null if the App isn't installed on it. */
export async function linkTo(app: GitHubApp, repo: string, fetcher: typeof fetch = fetch): Promise<GitHubLink | null> {
	const token = (signal?: AbortSignal) => installationToken(app, repo, fetcher, signal);
	try {
		await token();
	} catch (err) {
		if (err instanceof GitHubError && err.status === 404) return null;
		throw err;
	}
	return {
		repo,
		// Installation tokens authenticate git over HTTPS as the user x-access-token.
		remote: { url: `https://github.com/${repo}.git`, token: await token(), user: "x-access-token" },
		runsFor: async (sha) => {
			const path = `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`;
			const runs = await api<{ workflow_runs: ApiWorkflowRun[] }>(await token(), "GET", path, undefined, fetcher);
			return runs.workflow_runs.map(toWorkflowRun);
		},
		deleteBranch: async (name) => {
			await api(await token(), "DELETE", `/repos/${repo}/git/refs/heads/${name}`, undefined, fetcher).catch((err) => {
				if (!(err instanceof GitHubError && err.status === 422)) throw err;
			});
		},
		defaultHead: async (signal) => {
			const kept = defaults.get(repo);
			const read = async () =>
				(await api<{ default_branch: string }>(await token(signal), "GET", `/repos/${repo}`, undefined, fetcher, signal))
					.default_branch;
			const branch = kept && kept.until > Date.now() ? kept.branch : await read();
			defaults.set(repo, { branch, until: Date.now() + DEFAULT_KEPT_MS });
			return { branch, head: await branchHeadOf(await token(signal), repo, branch, fetcher, signal) };
		},
		openPull: async (head, signal) => {
			const owner = repo.split("/")[0];
			const query = `head=${encodeURIComponent(`${owner}:${head}`)}&state=open&per_page=1`;
			const path = `/repos/${repo}/pulls?${query}`;
			const pulls = await api<ApiPull[]>(await token(signal), "GET", path, undefined, fetcher, signal);
			return pulls[0] ? toPull(pulls[0]) : null;
		},
		createPull: async (input) =>
			toPull(await api<ApiPull>(await token(), "POST", `/repos/${repo}/pulls`, input, fetcher)),
		updatePull: async (number, input) =>
			toPull(await api<ApiPull>(await token(), "PATCH", `/repos/${repo}/pulls/${number}`, input, fetcher)),
	};
}
