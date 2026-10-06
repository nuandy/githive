import { describe, expect, it } from "vitest";
import { buildInbox } from "./inbox";

describe("the inbox", () => {
	it("groups waiting changes by repo, most recently active first, and counts them", () => {
		const { groups, count } = buildInbox({
			tasks: [
				{ id: "old", repo: "my-app", createdAt: "2026-01-01T00:00:00Z", elected: true, summary: { waiting: [{ change: "stale", title: "Stale", reason: "from an old task" }] } },
				{ id: "new", repo: "my-app", createdAt: "2026-02-01T00:00:00Z", elected: true, summary: { lastActivity: "2026-10-01T00:00:00Z", waiting: [{ change: "rate-limit", title: "Rate limiter", reason: "Reviewers disagree" }] } },
				{ id: "calm", repo: "calm", createdAt: "2026-02-01T00:00:00Z", elected: true, summary: { open: 2 } },
			],
			free: [{ repo: "docs site", since: "2026-01-01T00:00:00Z", summary: { lastActivity: "2026-10-02T00:00:00Z", waiting: [{ change: "c-1", title: "", reason: "Blueprint's builder failed" }] } }],
		});
		expect(count).toBe(2);
		expect(groups.map((g) => [g.repo, g.mode])).toEqual([
			["docs site", "coordinator-free"],
			["my-app", "elected"],
		]);
		expect(groups[0].items[0]).toEqual({ change: "c-1", title: "c-1", reason: "Blueprint's builder failed", href: "#/free/docs%20site/changes/c-1" });
		expect(groups[1].items).toEqual([{ change: "rate-limit", title: "Rate limiter", reason: "Reviewers disagree", href: "#/repos/my-app/changes/rate-limit" }]);
	});

	it("is empty before the summaries arrive, or when nothing waits", () => {
		expect(buildInbox(undefined)).toEqual({ groups: [], count: 0 });
		expect(buildInbox({ tasks: [{ id: "a", repo: "a", createdAt: "", summary: null }], free: [] })).toEqual({ groups: [], count: 0 });
	});
});
