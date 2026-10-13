import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import type { Claim, Vote } from "../lib/claimStatus";
import { ago, repoSnapshot as snapshot, visibleText } from "../test/fixtures";
import { VoteForm } from "./VoteForm";

// A person's vote on a change's head, from its page.

const pushedClaim: Claim = snapshot.claims[0]!;
const askingClaim: Claim = {
	...pushedClaim,
	attention: { reason: "reviewers disagree on the cache size", agent: "agent-c", at: "" },
};
const policy = snapshot.policy;
const voteApi = { vote: async () => ({}) };

const render = (claim: Claim, props: Partial<Parameters<typeof VoteForm>[0]> = {}) =>
	renderToStaticMarkup(<VoteForm repo="acme/docs-site" claim={claim} policy={policy} api={voteApi} {...props} />);

describe("a person's vote", () => {
	it("starts with no verdict chosen and says what's missing", () => {
		const html = render(pushedClaim);
		expect(html).not.toMatch(/<input[^>]*checked/);
		expect(visibleText(html)).toContain("Choose a verdict and say what you checked.");
		expect(html).toMatch(
			/<button[^>]*disabled[^>]*aria-describedby="vote-missing"|aria-describedby="vote-missing"[^>]*disabled/,
		);
		expect(html).toContain('id="vote-missing"');
	});

	it("names each role's reviewer once", () => {
		const html = render(pushedClaim);
		expect(html).toMatch(/<option value="review"[^>]*>reviewer<\/option>/);
		expect(html).toMatch(/<option value="security"[^>]*>security reviewer<\/option>/);
		expect(visibleText(html)).not.toContain("review reviewer");
	});

	it("asks for an answer when the agent asked a question", () => {
		const text = visibleText(render(askingClaim));
		expect(text).toContain(`Your answer to ${askingClaim.attention!.agent}`);
		expect(text).not.toContain("What you checked");
	});

	it("says what each verdict does, in the dashboard's words, and offers a block only as a role that can", () => {
		const text = visibleText(render(pushedClaim));
		expect(text).toContain("Approve");
		expect(text).toContain("These changes can land.");
		expect(text).toContain("Request changes");
		expect(text).toContain("land on this push");
		expect(text).not.toMatch(/\bmerg/i);
		// Voting as review, nothing blocks; as security, a rejection blocks.
		expect(text).not.toContain("Block as");
		const asSecurity = visibleText(render(pushedClaim, { initialRole: "security" }));
		expect(asSecurity).toContain("Block as security");
		expect(asSecurity).toContain("whatever its approvals");
	});

	it("offers only the roles the reader holds, when it can tell", () => {
		const guarded: RepoSnapshot["policy"] = {
			...policy,
			vetoes: ["security", "payments"],
			grants: { security: ["person:ana"], payments: ["@acme/payments"] },
		};
		const options = (html: string) => [...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
		const html = render(pushedClaim, { policy: guarded, reader: { by: "person:ana", teams: ["@acme/web"] } });
		expect(options(html)).toEqual(["review", "security"]);
		// Its only role is review: nothing to choose.
		const bob = render(pushedClaim, { policy: guarded, reader: { by: "person:bob", teams: [] } });
		expect(options(bob)).toEqual([]);
		// Who they are unknown: every role, and which are theirs.
		const unknown = render(pushedClaim, { policy: guarded, reader: {} });
		expect(options(unknown)).toEqual(["review", "security", "payments"]);
		expect(visibleText(unknown)).toContain("payments counts only from @acme/payments");
	});

	it("folds to what the reader voted once they have, and offers to change it", () => {
		const mine: Vote = {
			commit: pushedClaim.head!,
			reviewer: "person:ana",
			role: "review",
			verdict: "approve",
			evidence: "ok",
			at: ago(1),
			by: "person:ana",
		};
		const text = visibleText(render(pushedClaim, { mine }));
		expect(text).toContain("You approved b1c2d3e");
		expect(text).toContain("Change");
		expect(text).not.toContain("Submit vote");
		expect(visibleText(render(pushedClaim, { mine: { ...mine, verdict: "reject" } }))).toContain(
			"You asked for changes on b1c2d3e",
		);
		expect(visibleText(render(pushedClaim, { mine: { ...mine, verdict: "reject", role: "security" } }))).toContain(
			"You blocked b1c2d3e as security",
		);
	});
});
