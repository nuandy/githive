import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimCovering } from "../src/claim-paths";
import { readBranch } from "../src/toolkit/tools/claim-input";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// A finished branch merges into another as one change. It is claimed with
// `source`: the claim covers what the branch changed, and the branch tip is the
// change, reviewed, checked and merged like any other. The target branch never
// holds half of it.

describe("reading a branch to merge", () => {
	it("says the branch is missing only when the server doesn't list it, and otherwise why the read failed", async () => {
		const project = { url: server.url, token: "test" };
		const brokenOff = () => Promise.reject(new Error("the server broke off the pack"));
		await expect(readBranch(project, "main", brokenOff)).rejects.toThrow(
			/\[502\] reading main failed: the server broke off the pack/,
		);
		await expect(readBranch(project, "nope", brokenOff)).rejects.toThrow(/\[409\] there's no branch nope/);
		await expect(readBranch(project, "main", async () => "read")).resolves.toBe("read");
	});
});

describe("a claim covering a branch's changes", () => {
	it("is the files when they fit, and their folders, deepest first, when they don't", () => {
		expect(claimCovering(["a/x.ts", "b.ts"], 5)).toEqual(["a/x.ts", "b.ts"]);
		const files = ["src/billing/a.ts", "src/billing/b.ts", "src/billing/deep/c.ts", "src/ui/d.ts", "README.md"];
		expect(claimCovering(files, 4)).toEqual(["README.md", "src/billing/", "src/ui/"]);
		expect(claimCovering(files, 2)).toEqual(["README.md", "src/"]);
		expect(claimCovering(["a.ts", "b.ts", "c.ts"], 2)).toBeNull();
	});
});

let server: GitServer;
let work: string;
const { call, register, approve } = toolCalls(() => server);
const tip = (branch: string) => server.git("rev-parse", branch).trim();

/** A piece of the feature, claimed into feature/f, pushed, approved and merged there. */
async function piece(
	change: string,
	agent: string,
	files: Record<string, string>,
	extra: Record<string, unknown> = {},
) {
	await call("claim", { change, agent, paths: Object.keys(files), intent: change, into: "feature/f", ...extra }, agent);
	const head = await pushChange(server.url, work, agent, change, files, "origin/feature/f");
	await approve(head);
	expect(await call("merge", { change, agent }, agent)).toMatchObject({ ok: true });
}

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-branch-merge-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe.each([
	["kept in one record", undefined],
	["sharded", 2],
])("with claims %s", (_mode, shardDepth) => {
	beforeEach(async () => {
		await call("settings", { required: 1, vetoes: [], ...(shardDepth ? { shard_depth: shardDepth } : {}) });
		await register("a", "b", "lander", "other", "reviewer");
		await piece("api", "a", { "api/field.js": "the field\n" }, { from: "main" });
		await piece("consumer", "b", { "web/field.js": "uses the field\n" }, { after: ["api"] });
	}, 60_000);

	describe("merging a branch into another", { timeout: 60_000 }, () => {
		it("lands the whole branch on main in one merge, after review, and the audit finds nothing wrong", async () => {
			const main = tip("main");
			const claimed = await call(
				"claim",
				{ change: "land-f", agent: "lander", source: "feature/f", intent: "land the field" },
				"lander",
			);
			expect(claimed).toMatchObject({
				ok: true,
				source: "feature/f",
				head: tip("feature/f"),
				claimed: ["api/field.js", "web/field.js"],
			});
			// Its tip is the change, in the lander's fork as changes/land-f.
			expect(tip("changes/land-f")).toBe(tip("feature/f"));
			// main had neither piece until now.
			expect(server.git("ls-tree", "-r", "--name-only", "main")).not.toContain("api/field.js");
			await approve(tip("feature/f"));
			expect(await call("merge", { change: "land-f", agent: "lander" }, "lander")).toMatchObject({ ok: true });
			expect(server.git("log", "-1", "--format=%P", "main").trim().split(" ")).toEqual([main, tip("feature/f")]);
			const files = server.git("ls-tree", "-r", "--name-only", "main");
			expect(files).toContain("api/field.js");
			expect(files).toContain("web/field.js");
			expect(await call("audit", {})).toMatchObject({ merges: 3, open: 0 });
		});

		it("holds what the branch changed on main while it's under way", async () => {
			await call("claim", { change: "land-f", agent: "lander", source: "feature/f", intent: "land" }, "lander");
			expect(
				await call("claim", { change: "tweak", agent: "other", paths: ["api/field.js"], intent: "tweak" }, "other"),
			).toMatchObject({ ok: false, conflicts: [{ change: "land-f" }] });
			expect(
				await call("claim", { change: "elsewhere", agent: "other", paths: ["docs/"], intent: "docs" }, "other"),
			).toMatchObject({ ok: true });
		});

		it("comes up to the branch's new tip when claimed again after it moved", async () => {
			await call("claim", { change: "land-f", agent: "lander", source: "feature/f", intent: "land" }, "lander");
			const first = tip("changes/land-f");
			await piece("polish", "a", { "web/style.css": "polish\n" });
			expect(
				await call("claim", { change: "land-f", agent: "lander", source: "feature/f", intent: "land" }, "lander"),
			).toMatchObject({ ok: true, head: tip("feature/f") });
			expect(tip("changes/land-f")).not.toBe(first);
			expect(tip("changes/land-f")).toBe(tip("feature/f"));
		});

		it("brings the project's branch into the feature the same way, to keep it up to date", async () => {
			// main moves on after the feature left it.
			await call("claim", { change: "docs", agent: "other", paths: ["docs/"], intent: "docs" }, "other");
			await approve(await pushChange(server.url, work, "other", "docs", { "docs/new.md": "new\n" }));
			expect(await call("merge", { change: "docs", agent: "other" }, "other")).toMatchObject({ ok: true });
			expect(
				await call(
					"claim",
					{ change: "sync-f", agent: "lander", source: "main", into: "feature/f", intent: "bring main in" },
					"lander",
				),
			).toMatchObject({ ok: true, into: "feature/f", claimed: ["docs/new.md"] });
			await approve(tip("main"));
			expect(await call("merge", { change: "sync-f", agent: "lander" }, "lander")).toMatchObject({ ok: true });
			expect(server.git("ls-tree", "-r", "--name-only", "feature/f")).toContain("docs/new.md");
		});

		it("is refused when the branch has nothing new, or doesn't exist", async () => {
			await expect(
				call("claim", { change: "x", agent: "lander", source: "main", into: "feature/f", intent: "x" }, "lander"),
			).rejects.toThrow(/main has nothing feature\/f doesn't have/);
			await expect(
				call("claim", { change: "y", agent: "lander", source: "feature/nope", intent: "y" }, "lander"),
			).rejects.toThrow(/there's no branch feature\/nope/);
			await expect(
				call("claim", { change: "z", agent: "lander", source: "main", intent: "z" }, "lander"),
			).rejects.toThrow(/can't merge main into itself/);
		});
	});
});
