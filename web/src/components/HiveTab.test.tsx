import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ago, NOW, repoSnapshot, visibleText } from "../test/fixtures";
import { Hive } from "./HiveTab";

// The Hive tab: who works on the repo, what each is doing, and that nothing assigns the work.

describe("the Hive tab", () => {
	it("leads with the agents at work and how they're coordinated, then lists each agent's change", () => {
		// rev-1 reviewed five minutes ago, so it's still in the hive.
		const votes = repoSnapshot.votes.map((vote) => ({ ...vote, at: ago(5) }));
		const snapshot = { ...repoSnapshot, votes };
		const html = renderToStaticMarkup(<Hive repo="acme/docs-site" branch="main" snapshot={snapshot} now={NOW} />);
		const text = visibleText(html);
		expect(text).toContain("2 agents in the hive");
		expect(text).toContain("No queen: nothing assigns the work");
		expect(text).toContain("agent-c in review c-1 1 of 2 approvals");
		expect(text).toContain("rev-1 reviewing c-1 approved c-1");
		expect(html).toContain('href="#/repos/acme/docs-site/changes/c-1"');
	});

	it("says how to bring the first agent in when the hive is empty", () => {
		const empty = { ...repoSnapshot, claims: [], votes: [] };
		const text = visibleText(
			renderToStaticMarkup(<Hive repo="acme/docs-site" branch="main" snapshot={empty} now={NOW} />),
		);
		expect(text).toContain("No agents in the hive yet");
	});
});
