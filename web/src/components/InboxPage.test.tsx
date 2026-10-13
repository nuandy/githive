import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildInbox } from "../lib/inbox";
import { visibleText } from "../test/fixtures";
import { InboxPage } from "./InboxPage";

// The Inbox's rows: each says what kind it is, who waits and how long, what they ask at body size, and what to do.

const NOW = Date.parse("2026-10-13T12:00:00Z");

const { groups } = buildInbox({
	repos: [
		{
			repo: "acme/shop",
			since: "",
			summary: {
				violations: 2,
				waiting: [
					{
						kind: "vote",
						role: "payments",
						change: "refunds",
						title: "Handle Stripe refund webhooks",
						reason: "",
						agent: "sam/codex",
						at: "2026-10-13T10:00:00Z",
					},
					{
						kind: "question",
						change: "stock-sync",
						title: "Sync stock levels",
						reason: "Is it OK to poll every 5 minutes?",
						agent: "mara/claude",
						at: "2026-10-13T11:22:00Z",
						urgency: 1.8,
					},
				],
			},
		},
	],
});

describe("the Inbox page", () => {
	const html = renderToStaticMarkup(<InboxPage groups={groups} loaded now={NOW} />);
	const text = visibleText(html);

	it("says who waits and how long, and what they ask at body size in ink", () => {
		expect(text).toContain("mara/claude asks · 38m");
		expect(text).toContain("38 minutes ago");
		expect(html).toMatch(
			/<p class="[^"]*\btext-body\b[^"]*\btext-foreground\b[^"]*">Is it OK to poll every 5 minutes\?<\/p>/,
		);
		expect(text).toContain("sam/codex waits on a payments vote · 2h");
		expect(html).toMatch(/aria-label="A question"/);
		expect(html).toMatch(/aria-label="A vote"/);
		expect(html).toMatch(/aria-label="The audit"/);
	});

	it("puts an urgent question first, with its badge", () => {
		expect(text.indexOf("Urgent")).toBeGreaterThan(-1);
		expect(text.indexOf("mara/claude asks")).toBeLessThan(text.indexOf("sam/codex waits"));
	});

	it("offers the verb on a button: answer or vote at the change's decision, or see the audit", () => {
		expect(html).toMatch(/<a [^>]*href="#\/repos\/acme\/shop\/changes\/stock-sync\?decide"[^>]*>Answer<\/a>/);
		expect(html).toMatch(/<a [^>]*href="#\/repos\/acme\/shop\/changes\/refunds\?decide"[^>]*>Vote as payments<\/a>/);
		expect(html).toMatch(/<a [^>]*href="#\/repos\/acme\/shop\/audit"[^>]*>See the audit<\/a>/);
	});

	it("has a live region for what arrives while it's open", () => {
		expect(html).toContain('aria-live="polite"');
	});
});
