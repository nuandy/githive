import type { Context, Hono } from "hono";
import { defaultBranchOf, fileAt } from "../artifacts";
import { resolveRepo } from "../auth/access-control";
import { SizedCache } from "../sized-cache";
import type { Registry } from "../toolkit/claims";
import { forkName } from "../toolkit/env";
import { claimsRef, recordLog, storeFor } from "../toolkit/tools/repo";
import { type AppEnv, toolContext } from "./shared";

// A public repo's static site, served straight from its files, so people can see what the agents built: its default
// branch at /site/<owner>/<repo>/, and a change's latest push at /site/<owner>/<repo>/@<change>/. Nothing is built or
// run on GitHive's side; the browser runs the site.
//
// The pages share githive.app's origin with the dashboard and its session cookie, so every answer, errors and
// redirects included, makes the page a sandbox with an origin of its own: it can't read GitHive's cookies or act as
// the visitor. Only public repos are served, found the way a signed-out read finds them.

const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

const TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	md: "text/plain; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	wasm: "application/wasm",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	webm: "video/webm",
	pdf: "application/pdf",
};

/** A file's type by its extension, never by its bytes. */
export function typeOf(path: string) {
	const dot = path.lastIndexOf(".");
	const extension = dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : "";
	return TYPES[extension] ?? "application/octet-stream";
}

/** The headers every answer carries, so no page it makes runs with githive.app's origin. */
export function sandboxed(headers: Record<string, string> = {}) {
	return new Headers({
		...headers,
		"Content-Security-Policy": SANDBOX,
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		// A sandboxed page's origin is opaque, so even its own module scripts and fetches are cross-origin.
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
	});
}

const answer = (status: number, text: string) =>
	new Response(text, { status, headers: sandboxed({ "Content-Type": "text/plain; charset=utf-8" }) });

const redirect = (to: string) => new Response(null, { status: 302, headers: sandboxed({ Location: to }) });

// Segments that would climb out of the site, as a browser or the store might read them.
const CLIMBS = new Set([".", ".."]);

/** What a site path asks for: the default branch or a change, and a file in it. Null if it isn't one. */
export function sitePath(rest: string): { change?: string; path: string; needsSlash: boolean } | null {
	if (!rest.startsWith("@")) return fileOf(rest);
	const slash = rest.indexOf("/");
	const change = slash < 0 ? rest.slice(1) : rest.slice(1, slash);
	if (!/^[A-Za-z0-9._-]+$/.test(change)) return null;
	if (CLIMBS.has(change)) return null;
	if (slash < 0) return { change, path: "", needsSlash: true };
	const file = fileOf(rest.slice(slash + 1));
	return file && { ...file, change };
}

// A file in the site: a folder means its index.html.
function fileOf(path: string) {
	if (path.includes("\\")) return null;
	let segments: string[];
	try {
		segments = path.split("/").map(decodeURIComponent);
	} catch {
		return null;
	}
	if (segments.some((segment) => CLIMBS.has(segment))) return null;
	const folder = segments.at(-1) === "";
	return { path: folder ? `${segments.join("/")}index.html` : segments.join("/"), needsSlash: false };
}

// Which fork holds each change, for a minute: a page's every file asks.
const changeForks = new SizedCache<{ fork: string; until: number }>("site forks", 512);
const FORK_KEPT_MS = 60_000;

// Each repo's default branch, for a minute: Artifacts reads a file at a branch, tag or commit, not at HEAD.
const branches = new SizedCache<{ branch: string; until: number }>("site branches", 512);

async function siteBranch(env: Env, repo: string) {
	const kept = branches.get(repo);
	if ((kept?.until ?? 0) > Date.now()) return kept!.branch;
	const branch = await defaultBranchOf(env.ARTIFACTS, repo);
	branches.set(repo, { branch, until: Date.now() + FORK_KEPT_MS });
	return branch;
}

async function changeFork(env: Env, repo: string, change: string) {
	const key = `${repo}|${change}`;
	const kept = changeForks.get(key);
	if ((kept?.until ?? 0) > Date.now()) return kept!.fork;
	const ctx = toolContext(env, undefined);
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	if (!registry) return null;
	const { claim, released } = await storeFor(ctx, repo, registry).readChange(change);
	const agent = claim?.agent ?? released.at(-1)?.agent;
	if (!agent) return null;
	const fork = await forkName(repo, agent);
	changeForks.set(key, { fork, until: Date.now() + FORK_KEPT_MS });
	return fork;
}

async function serve(c: Context<AppEnv>) {
	const owner = c.req.param("owner");
	const name = c.req.param("name");
	const base = `/site/${owner}/${name}/`;
	if (!c.req.path.startsWith(base)) return redirect(`${base}`);
	const asked = sitePath(c.req.path.slice(base.length));
	if (!asked) return answer(400, "Not a file in this site.");
	if (asked.needsSlash) return redirect(`${c.req.path}/`);
	const notFound = () => answer(404, `No public site at ${owner}/${name}.`);
	// Found as a signed-out read, so a private repo is never served, whoever asks.
	const repo = await resolveRepo(c.env, undefined, `${owner}/${name}`, "read").catch(() => null);
	if (!repo) return notFound();
	const where = asked.change
		? { name: await changeFork(c.env, repo.id, asked.change), ref: `changes/${asked.change}` }
		: { name: repo.id, ref: await siteBranch(c.env, repo.id) };
	if (!where.name) return answer(404, `No change ${asked.change} in ${owner}/${name}.`);
	const bytes = await fileAt(c.env.ARTIFACTS, where.name, where.ref, asked.path);
	if (bytes === "too big") return answer(413, `${asked.path} is too big to serve.`);
	if (bytes) return new Response(bytes, { headers: sandboxed({ "Content-Type": typeOf(asked.path) }) });
	if (await isFolder(c.env, where.name, where.ref, asked.path)) return redirect(`${c.req.path}/`);
	const site = asked.change ? `change ${asked.change}` : `${owner}/${name}`;
	return answer(404, `No ${asked.path} in ${site}.`);
}

// A folder asked for without its slash, which relative links in its page need.
async function isFolder(env: Env, repo: string, ref: string, path: string) {
	if (path.endsWith("index.html")) return false;
	return !!(await fileAt(env.ARTIFACTS, repo, ref, `${path}/index.html`));
}

export function siteRoutes(app: Hono<AppEnv>) {
	const handler = (c: Context<AppEnv>) =>
		serve(c).catch((err) => {
			console.error(`serving ${c.req.path} failed`, String(err));
			return answer(502, "The site couldn't be read just now. Try again shortly.");
		});
	app.get("/site/:owner/:name", handler);
	app.get("/site/:owner/:name/*", handler);
}
