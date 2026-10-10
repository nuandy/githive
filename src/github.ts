import type { Remote } from "./git";

// GitHive's GitHub App, used to push main to a connected GitHub repo after each landing and to run checks on
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

/** A GitHub repo GitHive may write to, with its git remote and the REST calls GitHive uses. */
export interface GitHubLink {
	repo: string;
	remote: Remote;
	runsFor(sha: string): Promise<WorkflowRun[]>;
	deleteBranch(name: string): Promise<void>;
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

/** Calls GitHub's REST API with a JWT or an installation token. */
async function api<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
	fetcher: typeof fetch = fetch,
): Promise<T> {
	const res = await fetcher(`${API}${path}`, {
		method,
		headers: { ...HEADERS, Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	if (!res.ok)
		throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
	return (res.status === 204 ? undefined : await res.json()) as T;
}

const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
const encoder = new TextEncoder();

/** The App's JWT, valid for 9 minutes because GitHub allows at most 10, and backdated a minute for clock drift. */
export async function appJwt(app: GitHubApp, now = Date.now()) {
	const der = Uint8Array.from(atob(app.privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) =>
		c.charCodeAt(0),
	);
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
		"sign",
	]);
	const seconds = Math.floor(now / 1000);
	const unsigned = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: app.appId })))}`;
	const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned)));
	return `${unsigned}.${base64url(signature)}`;
}

/** Installation tokens by repo, reused until five minutes before they expire. */
const tokens = new Map<string, { token: string; until: number }>();

/** A link to `repo` (owner/name) through the App, or null if the App isn't installed on it. */
export async function linkTo(app: GitHubApp, repo: string, fetcher: typeof fetch = fetch): Promise<GitHubLink | null> {
	const token = async () => {
		const kept = tokens.get(repo);
		if (kept && kept.until > Date.now()) return kept.token;
		const jwt = await appJwt(app);
		const installation = await api<{ id: number }>(jwt, "GET", `/repos/${repo}/installation`, undefined, fetcher);
		const name = repo.split("/")[1];
		const issued = await api<{ token: string; expires_at: string }>(
			jwt,
			"POST",
			`/app/installations/${installation.id}/access_tokens`,
			{ repositories: [name] },
			fetcher,
		);
		tokens.set(repo, { token: issued.token, until: Date.parse(issued.expires_at) - 5 * 60_000 });
		return issued.token;
	};
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
		runsFor: async (sha) =>
			(
				await api<{
					workflow_runs: { id: number; name: string; status: string; conclusion: string | null; html_url: string }[];
				}>(await token(), "GET", `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`, undefined, fetcher)
			).workflow_runs.map((r) => ({
				id: r.id,
				name: r.name,
				status: r.status,
				conclusion: r.conclusion,
				url: r.html_url,
			})),
		deleteBranch: async (name) => {
			await api(await token(), "DELETE", `/repos/${repo}/git/refs/heads/${name}`, undefined, fetcher).catch((err) => {
				if (!(err instanceof GitHubError && err.status === 422)) throw err;
			});
		},
	};
}
