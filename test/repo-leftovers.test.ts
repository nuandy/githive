import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";
import { leftoversOf } from "../src/artifacts";

// What a deleted repo leaves behind, and goes with it: its agents' forks and
// its claim shards, and never another repo's, however alike their names.

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "person", value: "admin@example.com" })),
}));

const names = [
	"acme--web",
	"fork--acme--web--agent--nuandy-claude-code-f29858",
	"fork--acme--web--agent--builder",
	"fork--acme--web--contributing-guide",
	"records--acme--web--0",
	"records--acme--web--7",
	// A longer repo id that starts with the deleted one's, and its leftovers.
	"acme--web--old",
	"fork--acme--web--old--agent--builder",
	"records--acme--web--old--2",
	// Unrelated.
	"acme--docs",
	"fork--acme--docs--agent--builder",
	"records--acme--webx--1",
];

describe("a repo's leftovers", () => {
	it("are its agents' forks, its older per-change forks and its claim shards", () => {
		expect(leftoversOf("acme--web", names)).toEqual({
			forks: [
				"fork--acme--web--agent--nuandy-claude-code-f29858",
				"fork--acme--web--agent--builder",
				"fork--acme--web--contributing-guide",
			],
			shards: ["records--acme--web--0", "records--acme--web--7"],
		});
	});

	it("never include a longer repo's, nor anything else", () => {
		const { forks, shards } = leftoversOf("acme--web", names);
		expect([...forks, ...shards].some((n) => n.includes("--old") || n.includes("docs") || n.includes("webx"))).toBe(
			false,
		);
		// Deleting a short legacy id doesn't touch an org repo whose id begins with it.
		expect(leftoversOf("acme", ["acme", "acme--agent", "fork--acme--agent--agent--x", "fork--acme--agent--y"])).toEqual(
			{ forks: [], shards: [] },
		);
	});

	/** Artifacts over `names`, each made at `made` (or long ago), recording what's deleted. */
	const artifactsOver = (made: Record<string, number> = {}) => {
		const deleted: string[] = [];
		const live = () => names.filter((name) => !deleted.includes(name));
		const ARTIFACTS = {
			list: vi.fn(async () => ({ repos: live().map((name) => ({ name })) })),
			delete: vi.fn(async (name: string) => (deleted.push(name), true)),
			get: vi.fn(async (name: string) => {
				if (!live().includes(name)) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
				return { info: async () => ({ createdAt: new Date(made[name] ?? 0).toISOString() }) };
			}),
		};
		return { ARTIFACTS, deleted };
	};

	/** Deletes acme--web through the route, then lets the repo index work through what it left, alarm by alarm. */
	async function deleteAcmeWeb(made: Record<string, number> = {}) {
		const worker = (await import("../src/index")).default;
		const { RepoIndex } = await import("../src/repo-index");
		const { ARTIFACTS, deleted } = artifactsOver(made);
		const env = { ARTIFACTS } as Record<string, unknown>;
		const index = new RepoIndex({ storage: new FakeStorage() } as never, env as never);
		env.REPO_INDEX = { getByName: () => index };
		const response = await worker.fetch(
			new Request("https://githive.test/repos/_/acme--web", { method: "DELETE" }),
			env as never,
			{ waitUntil: () => {} } as never,
		);
		while ((await index.leftoversToGo()) > 0) await index.alarm();
		return { response, deleted };
	}

	it("go when the repo is deleted: the repo at once, its forks and shards in the background", async () => {
		const { response, deleted } = await deleteAcmeWeb();
		expect(await response.json()).toEqual({ deleted: "_/acme--web", forks: 3, shards: 2, cleaningUp: true });
		expect(deleted.sort()).toEqual([
			"acme--web",
			"fork--acme--web--agent--builder",
			"fork--acme--web--agent--nuandy-claude-code-f29858",
			"fork--acme--web--contributing-guide",
			"records--acme--web--0",
			"records--acme--web--7",
		]);
	});

	it("leave a repo by a leftover's name made since the delete, a new repo's, alone", async () => {
		const { deleted } = await deleteAcmeWeb({ "fork--acme--web--agent--builder": Date.now() + 60_000 });
		expect(deleted).not.toContain("fork--acme--web--agent--builder");
		expect(deleted).toContain("fork--acme--web--contributing-guide");
	});
});
