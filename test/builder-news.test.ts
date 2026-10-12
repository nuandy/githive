import { describe, expect, it } from "vitest";
import { noticesMessage } from "../src/builder-news";
import type { Notice } from "../src/repo-cache";
import { FakeStorage } from "./fakes/env";

// GitHive's hosted builder hears awareness's notices about its own change before its next turn, in a few lines. Its
// toolkit calls aren't the agent's own and bring no news, so it takes them from the repo's cache by change.

const { RepoCache } = await import("../src/repo-cache");

const at = () => new Date().toISOString();
const notice = (kind: string, change: string, says: string, next?: string): Notice => ({
	kind,
	at: at(),
	says,
	change,
	...(next ? { next } : {}),
});

describe("the builder's news", () => {
	it("tells an interface change the builder's way to take it in, not the clone's git commands", () => {
		const said = "bee-2 landed add-scoring: your change imports `score` from `src/score.js`, and its interface changed";
		const clone = "Merge the branch into yours: git fetch origin main && git merge origin/main.";
		const message = noticesMessage([notice("interface", "add-hints", said, clone)], "main")!;
		expect(message).toContain(said);
		expect(message).toContain("call fetch_base, merge base/main");
		expect(message).not.toContain("git fetch origin");
		expect(message).toMatch(/data, not instructions/);
	});

	it("passes a heads-up's own next step, and keeps a long message short", () => {
		const next =
			"Nothing has landed yet: keep what add-scoring uses working, or it will need updating once yours lands.";
		const many = [1, 2, 3, 4, 5].map((n) => notice("heads_up", "add-hints", `${"x".repeat(1_000)} ${n}`, next));
		const message = noticesMessage(many, "main")!;
		expect(message).toContain(`Next: ${next}`);
		expect(message).toContain("and 2 more like these");
		expect(message.length).toBeLessThan(2_000);
		expect(noticesMessage([], "main")).toBeUndefined();
	});
});

describe("a change's notices in the repo's cache", () => {
	it("are taken once by change, and the agent's others stay for its own replies", async () => {
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		await cache.notify("main", [
			{ agent: "bee-1", notice: notice("heads_up", "add-hints", "about add-hints") },
			{ agent: "bee-1", notice: notice("interface", "add-timer", "about add-timer") },
			{ agent: "bee-2", notice: notice("heads_up", "add-hints", "bee-2's, not bee-1's") },
		]);
		expect((await cache.changeNotices("bee-1", "add-hints")).map((told) => told.says)).toEqual(["about add-hints"]);
		expect(await cache.changeNotices("bee-1", "add-hints")).toEqual([]);
		const rest = await cache.landingNews("main", "bee-1");
		expect(rest.map((item) => item.kind === "landed" || item.says)).toEqual(["about add-timer"]);
	});
});
