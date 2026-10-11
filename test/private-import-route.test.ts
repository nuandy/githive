import { describe, expect, it, vi } from "vitest";
import { OrgStore } from "../src/auth/orgs";
import { IdentityStore } from "../src/auth/store";
import { fakeD1 } from "./fakes/d1";

// POST /repos with a token imports a private repo: the token goes to a Gate made for that import, and nowhere else;
// a failed import leaves no empty repo behind.

vi.mock("../src/access", () => ({ verifyAccessRequest: vi.fn(async () => null) }));
const worker = (await import("../src/index")).default;
const ORIGIN = "https://githive.test";
const TOKEN = "github_pat_secret";

async function world(importPrivate: (input: unknown) => Promise<unknown>) {
	const DB = fakeD1();
	const ids = new IdentityStore(DB);
	await ids.invite("ada@example.com", "admin");
	const profile = { provider: "github", providerId: "ada", email: "ada@example.com", login: "ada" } as const;
	const { user } = (await ids.signIn(profile)) as { user: { id: string; handle: string; email: string } };
	await new OrgStore(DB).personalOrg(user);
	const session = `__Host-githive_session=${encodeURIComponent(await ids.createSession(user.id))}`;
	const gates: string[] = [];
	const deleted: string[] = [];
	const ARTIFACTS = {
		create: async () => ({}),
		get: async (name: string) => ({
			info: async () => ({ remote: `https://artifacts.test/${name}.git` }),
			createToken: async () => ({ plaintext: "art_v1_write?expires=1" }),
		}),
		delete: async (name: string) => void deleted.push(name),
		import: async () => {
			throw new Error("a private repo must not go through Artifacts' import");
		},
	};
	const GATE = { getByName: (name: string) => (gates.push(name), { importPrivate }) };
	const env = { DB, ARTIFACTS, GATE, ASSETS: { fetch: async () => new Response("page") } };
	const make = async (body: object) => {
		const request = new Request(`${ORIGIN}/repos`, {
			method: "POST",
			headers: { Cookie: session, Origin: ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({ owner: "ada", name: "app", ...body }),
		});
		const response = await worker.fetch(request, env as never, { waitUntil: () => {} } as never);
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};
	return { make, gates, deleted };
}

describe("making a repo from a private one", () => {
	it("hands the URL, branch and token to a Gate made for the import, with the new repo to push to", async () => {
		const importPrivate = vi.fn(async () => ({ branch: "main" }));
		const { make, gates } = await world(importPrivate);
		const made = await make({
			import_url: "https://github.com/ada/app.git",
			import_token: ` ${TOKEN} `,
			branch: "main",
		});
		expect(made.status).toBe(201);
		expect(gates).toEqual(["import:ada--app"]);
		expect(importPrivate).toHaveBeenCalledWith({
			source: { url: "https://github.com/ada/app.git", token: TOKEN, branch: "main" },
			target: { url: "https://artifacts.test/ada--app.git", token: "art_v1_write?expires=1" },
		});
		expect(JSON.stringify(made.body)).not.toContain(TOKEN);
	});

	it("removes the empty repo when the import fails, and says why", async () => {
		const { make, deleted } = await world(async () => {
			throw new Error("[400] GitHub refused the token: check it can read this repository's contents");
		});
		const made = await make({ import_url: "https://github.com/ada/app.git", import_token: TOKEN });
		expect(made.status).toBe(400);
		expect(made.body.error).toMatch(/GitHub refused the token/);
		expect(deleted).toEqual(["ada--app"]);
		// Nothing was registered, so the same name can be tried again.
		const again = await make({ import_url: "https://github.com/ada/app.git", import_token: TOKEN });
		expect(again.status).toBe(400);
	});
});
