import { describe, expect, it, vi } from "vitest";
import { leftoversOf } from "../src/artifacts";

// What a deleted repo leaves behind, and goes with it: its agents' forks and
// its claim shards, and never another repo's, however alike their names.

vi.mock("../src/access", () => ({ verifyAccessRequest: vi.fn(async () => ({ kind: "person", value: "admin@example.com" })) }));

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
			forks: ["fork--acme--web--agent--nuandy-claude-code-f29858", "fork--acme--web--agent--builder", "fork--acme--web--contributing-guide"],
			shards: ["records--acme--web--0", "records--acme--web--7"],
		});
	});

	it("never include a longer repo's, nor anything else", () => {
		const { forks, shards } = leftoversOf("acme--web", names);
		expect([...forks, ...shards].some((n) => n.includes("--old") || n.includes("docs") || n.includes("webx"))).toBe(false);
		// Deleting a short legacy id doesn't touch an org repo whose id begins with it.
		expect(leftoversOf("acme", ["acme", "acme--agent", "fork--acme--agent--agent--x", "fork--acme--agent--y"])).toEqual({ forks: [], shards: [] });
	});

	it("go when the repo is deleted", async () => {
		const worker = (await import("../src/index")).default;
		const deleted: string[] = [];
		const ARTIFACTS = {
			list: vi.fn(async () => ({ repos: names.filter((n) => !deleted.includes(n)).map((name) => ({ name })) })),
			delete: vi.fn(async (name: string) => (deleted.push(name), true)),
		};
		const response = await worker.fetch(new Request("https://githive.test/repos/_/acme--web", { method: "DELETE" }), { ARTIFACTS } as never, { waitUntil: () => {} } as never);
		expect(await response.json()).toEqual({ deleted: "_/acme--web", forks: 3, shards: 2 });
		expect(deleted.sort()).toEqual(["acme--web", "fork--acme--web--agent--builder", "fork--acme--web--agent--nuandy-claude-code-f29858", "fork--acme--web--contributing-guide", "records--acme--web--0", "records--acme--web--7"]);
	});
});
