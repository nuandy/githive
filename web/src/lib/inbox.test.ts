import { describe, expect, it } from "vitest";
import { buildInbox, isUrgent } from "./inbox";

describe("the inbox", () => {
	it("groups waiting changes by repo, most recently active first, and counts them", () => {
		const { groups, count } = buildInbox({
			repos: [
				{
					repo: "acme/my-app",
					since: "2026-01-01T00:00:00Z",
					summary: {
						lastActivity: "2026-10-01T00:00:00Z",
						waiting: [{ change: "rate-limit", title: "Rate limiter", reason: "Reviewers disagree" }],
					},
				},
				{
					repo: "acme/docs site",
					since: "2026-01-01T00:00:00Z",
					summary: {
						lastActivity: "2026-10-02T00:00:00Z",
						waiting: [{ change: "c-1", title: "", reason: "GitHive's builder failed" }],
					},
				},
				{ repo: "calm", since: "2026-01-01T00:00:00Z", summary: { open: 2 } },
			],
		});
		expect(count).toBe(2);
		expect(groups.map((g) => g.repo)).toEqual(["acme/docs site", "acme/my-app"]);
		// Summaries kept before `kind` are questions.
		expect(groups[0]!.items[0]).toEqual({
			kind: "question",
			key: "c-1",
			change: "c-1",
			title: "c-1",
			reason: "GitHive's builder failed",
			href: "#/repos/acme/docs%20site/changes/c-1",
		});
		expect(groups[1]!.items).toEqual([
			{
				kind: "question",
				key: "rate-limit",
				change: "rate-limit",
				title: "Rate limiter",
				reason: "Reviewers disagree",
				href: "#/repos/acme/my-app/changes/rate-limit",
			},
		]);
	});

	it("puts urgent questions first, and the repos that have one, whatever their activity", () => {
		const waiting = (urgencies: (number | undefined)[]) =>
			urgencies.map((urgency, index) => ({ change: `c-${index}`, title: "", reason: "?", urgency }));
		const { groups } = buildInbox({
			repos: [
				{ repo: "busy", since: "", summary: { lastActivity: "2026-10-02T00:00:00Z", waiting: waiting([0.4]) } },
				{ repo: "quiet", since: "", summary: { lastActivity: "2026-10-01T00:00:00Z", waiting: waiting([0.2, 1.8]) } },
			],
		});
		expect(groups.map((group) => group.repo)).toEqual(["quiet", "busy"]);
		expect(groups[0]!.items.map((item) => [item.change, isUrgent(item)])).toEqual([
			["c-1", true],
			["c-0", false],
		]);
	});

	it("counts votes only people may give and the audit's open violations, as the Hive and the repo list do", () => {
		const { groups, count } = buildInbox({
			repos: [
				{
					repo: "acme/shop",
					since: "",
					summary: {
						lastActivity: "2026-10-02T00:00:00Z",
						needsYou: 2,
						violations: 2,
						waiting: [
							{ kind: "vote", role: "payments", change: "refunds", title: "Handle Stripe refund webhooks", reason: "" },
							{ kind: "question", change: "cache", title: "Cache the cart", reason: "Which TTL?" },
						],
					},
				},
				{ repo: "acme/audited", since: "", summary: { violations: 1 } },
			],
		});
		expect(count).toBe(5);
		expect(groups.map((group) => [group.repo, group.count])).toEqual([
			["acme/shop", 4],
			["acme/audited", 1],
		]);
		expect(groups[0]!.items.map((item) => [item.kind, item.title, item.href])).toEqual([
			["vote", "Handle Stripe refund webhooks", "#/repos/acme/shop/changes/refunds"],
			["question", "Cache the cart", "#/repos/acme/shop/changes/cache"],
			["audit", "2 merges for the audit to look at", "#/repos/acme/shop/audit"],
		]);
		expect(groups[0]!.items[0]).toMatchObject({ role: "payments" });
	});

	it("is empty before the summaries arrive, or when nothing waits", () => {
		expect(buildInbox(undefined)).toEqual({ groups: [], count: 0 });
		expect(buildInbox({ repos: [{ repo: "a", since: "", summary: null }] })).toEqual({ groups: [], count: 0 });
	});

	it("leaves out someone else's public repo: its changes wait on its own people", () => {
		const waiting = [{ change: "c-1", title: "", reason: "Reviewers disagree" }];
		const { count } = buildInbox({
			repos: [{ repo: "bob/demo", since: "2026-01-01T00:00:00Z", summary: { waiting }, public: true }],
		});
		expect(count).toBe(0);
	});
});
