import { describe, expect, it } from "vitest";
import { FakeStorage } from "./fakes/env";

const { RepoIndex } = await import("../src/repo-index");

// The dashboard's list of repos, with a summary each: a hint kept so the list
// is one read. The records in Git are what count.

describe("the repo index", () => {
	it("lists repos oldest first, each once", async () => {
		const index = new RepoIndex({ storage: new FakeStorage() } as never, {} as never);
		await index.addRepo("docs");
		await index.addRepo("site");
		expect((await index.listRepos()).map((r) => r.repo)).toEqual(["docs", "site"]);
	});

	it("keeps a summary per repo, merging updates and adding merges", async () => {
		const index = new RepoIndex({ storage: new FakeStorage() } as never, {} as never);
		await index.addRepo("docs");
		await index.summarize("repo:docs", { open: 3 });
		await index.summarize("repo:docs", { mergedBy: 1, lastActivity: "2026-10-06T11:00:00.000Z" });
		await index.summarize("repo:docs", { mergedBy: 1 });
		expect((await index.summaries()).repos).toEqual([{ repo: "docs", since: expect.any(String), summary: { open: 3, merged: 2, lastActivity: "2026-10-06T11:00:00.000Z" } }]);
	});

	it("forgets everything when cleared", async () => {
		const index = new RepoIndex({ storage: new FakeStorage() } as never, {} as never);
		await index.addRepo("docs");
		await index.clear();
		expect((await index.summaries()).repos).toEqual([]);
	});
});
