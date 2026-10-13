import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Claim } from "../lib/claimStatus";
import { repoSnapshot as snapshot, visibleText } from "../test/fixtures";
import { VoteForm } from "./VoteForm";

// A person's vote on a change's head, from its page.

const pushedClaim: Claim = snapshot.claims[0]!;
const askingClaim: Claim = {
	...pushedClaim,
	attention: { reason: "reviewers disagree on the cache size", agent: "agent-c", at: "" },
};
const policy = snapshot.policy;
const voteApi = { vote: async () => ({}) };

const render = (claim: Claim) =>
	renderToStaticMarkup(<VoteForm repo="acme/docs-site" claim={claim} policy={policy} api={voteApi} />);

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
});
