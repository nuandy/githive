import { describe, expect, it } from "vitest";
import { buildInbox } from "./inbox";

describe("the inbox", () => {
	it("groups waiting changes by repo, most recently active first, and counts them", () => {
		const { groups, count } = buildInbox({
			free: [
				{ repo: "my-app", since: "2026-01-01T00:00:00Z", summary: { lastActivity: "2026-10-01T00:00:00Z", waiting: [{ change: "rate-limit", title: "Rate limiter", reason: "Reviewers disagree" }] } },
				{ repo: "docs site", since: "2026-01-01T00:00:00Z", summary: { lastActivity: "2026-10-02T00:00:00Z", waiting: [{ change: "c-1", title: "", reason: "Blueprint's builder failed" }] } },
				{ repo: "calm", since: "2026-01-01T00:00:00Z", summary: { open: 2 } },
			],
		});
		expect(count).toBe(2);
		expect(groups.map((g) => g.repo)).toEqual(["docs site", "my-app"]);
		expect(groups[0].items[0]).toEqual({ change: "c-1", title: "c-1", reason: "Blueprint's builder failed", href: "#/repos/docs%20site/changes/c-1" });
		expect(groups[1].items).toEqual([{ change: "rate-limit", title: "Rate limiter", reason: "Reviewers disagree", href: "#/repos/my-app/changes/rate-limit" }]);
	});

	it("is empty before the summaries arrive, or when nothing waits", () => {
		expect(buildInbox(undefined)).toEqual({ groups: [], count: 0 });
		expect(buildInbox({ free: [{ repo: "a", since: "", summary: null }] })).toEqual({ groups: [], count: 0 });
	});
});
