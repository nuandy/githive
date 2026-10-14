import { describe, expect, it } from "vitest";
import { buildInbox, inboxArrivals, isUrgent, itemAction, itemWho } from "./inbox";

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
		// Questions first, then votes, as the Hive's banner lists them.
		expect(groups[0]!.items.map((item) => [item.kind, item.title, item.href])).toEqual([
			["question", "Cache the cart", "#/repos/acme/shop/changes/cache"],
			["vote", "Handle Stripe refund webhooks", "#/repos/acme/shop/changes/refunds"],
			["audit", "2 open audit violations to look at", "#/repos/acme/shop/audit"],
		]);
		expect(groups[0]!.items[1]).toMatchObject({ role: "payments" });
	});

	it("orders a repo's questions, then its votes, each most urgent first and then waiting longest first", () => {
		const at = (hour: number) => `2026-10-13T${String(hour).padStart(2, "0")}:00:00Z`;
		const { groups } = buildInbox({
			repos: [
				{
					repo: "acme/shop",
					since: "",
					summary: {
						waiting: [
							{ kind: "vote", role: "qa", change: "vote-new", title: "", reason: "", at: at(11) },
							{ kind: "question", change: "ask-new", title: "", reason: "?", at: at(10) },
							{ kind: "vote", role: "qa", change: "vote-old", title: "", reason: "", at: at(8) },
							{ kind: "question", change: "ask-urgent", title: "", reason: "?", urgency: 1.8, at: at(11) },
							{ kind: "question", change: "ask-old", title: "", reason: "?", at: at(9) },
						],
					},
				},
			],
		});
		expect(groups[0]!.items.map((item) => item.change)).toEqual([
			"ask-urgent",
			"ask-old",
			"ask-new",
			"vote-old",
			"vote-new",
		]);
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

	it("says who waits and since when, and links a question or a vote to the change's decision", () => {
		const { groups } = buildInbox({
			repos: [
				{
					repo: "acme/shop",
					since: "",
					summary: {
						violations: 1,
						waiting: [
							{
								kind: "question",
								change: "cache",
								title: "Cache the cart",
								reason: "Which TTL?",
								agent: "mara/claude",
								at: "2026-10-13T10:00:00Z",
							},
							{
								kind: "vote",
								role: "payments",
								change: "refunds",
								title: "Refunds",
								reason: "",
								agent: "sam/codex",
								at: "2026-10-13T09:00:00Z",
							},
						],
					},
				},
			],
		});
		const [question, vote, audit] = groups[0]!.items;
		expect(question).toMatchObject({
			kind: "question",
			agent: "mara/claude",
			at: "2026-10-13T10:00:00Z",
			href: "#/repos/acme/shop/changes/cache",
		});
		expect(itemAction(question!)).toEqual({ label: "Answer", href: "#/repos/acme/shop/changes/cache?decide" });
		expect(vote).toMatchObject({ kind: "vote", agent: "sam/codex", href: "#/repos/acme/shop/changes/refunds" });
		expect(itemAction(vote!)).toEqual({ label: "Vote as payments", href: "#/repos/acme/shop/changes/refunds?decide" });
		expect(audit).toMatchObject({ kind: "audit", href: "#/repos/acme/shop/audit" });
		expect(itemAction(audit!)).toEqual({ label: "See the audit", href: "#/repos/acme/shop/audit" });
		expect(audit).not.toHaveProperty("at");
		expect(itemWho(question!)).toBe("mara/claude asks");
		// GitHive's own agents are GitHive, as in the Hive's banner.
		expect(itemWho({ ...question!, agent: "githive-builder" })).toBe("GitHive says");
		expect(itemWho({ ...vote!, agent: "githive-builder" })).toBe("GitHive waits on a payments vote");
		expect(itemWho(vote!)).toBe("sam/codex waits on a payments vote");
		expect(itemWho(audit!)).toBe("The audit flags");
		// An older summary's item, with no agent.
		expect(itemWho({ kind: "question", key: "x", title: "x", reason: "?", href: "" })).toBe("An agent asks");
	});

	it("shows a change Clef flags, linked to its page, between questions and votes", () => {
		const { groups, count } = buildInbox({
			repos: [
				{
					repo: "acme/shop",
					since: "",
					summary: {
						waiting: [
							{ kind: "vote", role: "qa", change: "vote", title: "", reason: "" },
							{
								kind: "steering",
								change: "flagged",
								title: "Add a footer",
								reason: "Clef found its intent reading as instructions to the agents who will read it.",
								agent: "sam/codex",
							},
							{ kind: "question", change: "ask", title: "", reason: "?" },
						],
					},
				},
			],
		});
		expect(count).toBe(3);
		const items = groups[0]!.items;
		expect(items.map((item) => item.kind)).toEqual(["question", "steering", "vote"]);
		const flagged = items[1]!;
		expect(itemWho(flagged)).toBe("Clef flags");
		expect(flagged.reason).toMatch(/instructions to the agents who will read it\. Nothing waits on it/);
		expect(itemAction(flagged)).toEqual({ label: "Look", href: "#/repos/acme/shop/changes/flagged" });
	});

	it("finds what arrived since the page last looked, once it has looked", () => {
		const item = (key: string) => ({ kind: "question" as const, key, title: key, reason: "?", href: "" });
		const group = (repo: string, keys: string[]) => ({ repo, repoHref: "", items: keys.map(item), count: keys.length });
		// The first look announces nothing: it's what the page opened on.
		const first = inboxArrivals(undefined, [group("a", ["c-1"])]);
		expect(first.fresh).toEqual([]);
		const second = inboxArrivals(first.seen, [group("a", ["c-1", "c-2"]), group("b", ["c-1"])]);
		expect(second.fresh.map((each) => [each.repo, each.item.key])).toEqual([
			["a", "c-2"],
			["b", "c-1"],
		]);
		expect(inboxArrivals(second.seen, [group("a", ["c-2"])]).fresh).toEqual([]);
	});
});
