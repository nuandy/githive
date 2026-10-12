import { describe, expect, it, vi } from "vitest";
import { OrgStore } from "../src/auth/orgs";
import { IdentityStore } from "../src/auth/store";
import { sitePath, typeOf } from "../src/routes/site";
import { fakeD1 } from "./fakes/d1";

// A public repo's site, served from its files in the Worker with SQLite for D1 and a stand-in for Artifacts' API.
// Every answer makes its page a sandbox, so the site can't act as whoever is looking at it on githive.app.

vi.mock("../src/access", () => ({ verifyAccessRequest: vi.fn(async () => null) }));
const worker = (await import("../src/index")).default;

/** Files by repo, ref and path, as Artifacts' readFile answers them. */
type Files = Record<string, Record<string, Record<string, string>>>;

async function world(files: Files) {
	const DB = fakeD1();
	const ids = new IdentityStore(DB);
	const orgs = new OrgStore(DB);
	await ids.invite("ada@example.com", "admin");
	const { user } = (await ids.signIn({
		provider: "github",
		providerId: "ada",
		email: "ada@example.com",
		login: "ada",
	})) as { user: { id: string; handle: string } };
	await orgs.personalOrg(user);
	const acme = await orgs.createOrg(user, "acme");
	await orgs.addRepo(acme, "web", user.id);
	await orgs.addRepo(acme, "docs", user.id, { visibility: "public" });
	const session = `__Host-githive_session=${encodeURIComponent(await ids.createSession(user.id))}`;
	const ARTIFACTS = {
		get: async (name: string) => ({
			readFile: async ({ ref, path }: { ref: string; path: string }) => {
				const text = files[name]?.[ref]?.[path];
				return text === undefined ? null : new Blob([text]);
			},
		}),
	};
	const env = { DB, ARTIFACTS, ASSETS: { fetch: async () => new Response("dashboard") } };
	const get = (path: string, cookie?: string) =>
		worker.fetch(
			new Request(`https://githive.test${path}`, cookie ? { headers: { Cookie: cookie } } : {}),
			env as never,
			{} as never,
		);
	return { get, session };
}

const site: Files = {
	"acme--docs": {
		HEAD: { "index.html": "<h1>Honeycomb</h1>", "style.css": "h1 {}", "game/index.html": "<p>play</p>" },
	},
	"acme--web": { HEAD: { "index.html": "<h1>private</h1>" } },
};

const expectSandboxed = (response: Response) => {
	expect(response.headers.get("Content-Security-Policy")).toMatch(/^sandbox /);
	expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
};

describe("a repo's site", () => {
	it("serves a public repo's files from its default branch, each typed by its extension and sandboxed", async () => {
		const { get } = await world(site);
		const page = await get("/site/acme/docs/");
		expect(page.status).toBe(200);
		expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(await page.text()).toBe("<h1>Honeycomb</h1>");
		expectSandboxed(page);
		const style = await get("/site/acme/docs/style.css");
		expect(style.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
		expectSandboxed(style);
	});

	it("adds the slash a folder's relative links need, and answers a missing file plainly, all sandboxed", async () => {
		const { get } = await world(site);
		for (const [path, to] of [
			["/site/acme/docs", "/site/acme/docs/"],
			["/site/acme/docs/game", "/site/acme/docs/game/"],
		]) {
			const moved = await get(path!);
			expect(moved.status, path).toBe(302);
			expect(moved.headers.get("Location"), path).toBe(to);
			expectSandboxed(moved);
		}
		const missing = await get("/site/acme/docs/nothing.js");
		expect(missing.status).toBe(404);
		expectSandboxed(missing);
	});

	it("never serves a private repo's files, even to its owner, and says no more than for no repo at all", async () => {
		const { get, session } = await world(site);
		for (const cookie of [undefined, session]) {
			const refused = await get("/site/acme/web/", cookie);
			expect(refused.status).toBe(404);
			expect(await refused.text()).toBe("No public site at acme/web.");
			expectSandboxed(refused);
		}
		expect(await (await get("/site/acme/nothing/")).text()).toBe("No public site at acme/nothing.");
	});

	it("can't be climbed out of: a path that tries is another repo's site, checked on its own", async () => {
		const { get } = await world(site);
		// The URL is read as /site/acme/web/index.html, a private repo's, so nothing is served.
		const climbing = await get("/site/acme/docs/%2e%2e/web/index.html");
		expect(climbing.status).toBe(404);
		expect(await climbing.text()).toBe("No public site at acme/web.");
		expectSandboxed(climbing);
	});
});

describe("a site path", () => {
	it("names the default branch or a change, and a folder means its index.html", () => {
		expect(sitePath("")).toEqual({ path: "index.html", needsSlash: false });
		expect(sitePath("game/")).toEqual({ path: "game/index.html", needsSlash: false });
		expect(sitePath("a%20b.png")).toEqual({ path: "a b.png", needsSlash: false });
		expect(sitePath("@add-scoring/js/app.js")).toEqual({
			change: "add-scoring",
			path: "js/app.js",
			needsSlash: false,
		});
		expect(sitePath("@add-scoring")).toEqual({ change: "add-scoring", path: "", needsSlash: true });
	});

	it("refuses climbing out, backslashes and change names that aren't names", () => {
		for (const path of ["../x", "a/./b", "a/%2e%2e/b", "a\\b", "@a b/x", "@../x", "%E0%A4%A"])
			expect(sitePath(path), path).toBeNull();
	});

	it("types a file by its extension only", () => {
		expect(typeOf("index.html")).toBe("text/html; charset=utf-8");
		expect(typeOf("app.mjs")).toBe("text/javascript; charset=utf-8");
		expect(typeOf("logo.SVG")).toBe("image/svg+xml");
		expect(typeOf("data.bin")).toBe("application/octet-stream");
		expect(typeOf("folder.d/README")).toBe("application/octet-stream");
	});
});
