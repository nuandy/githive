import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeHistory, MergeCheck } from "../api";
import type { Claim, Vote } from "../lib/claimStatus";
import { ago, historyFixture, repoSnapshot as snapshot, visibleText } from "../test/fixtures";
import { ChangePage, type ChangePageProps } from "./ChangePage";

// A change's page: where it stands, and what a person may do about it from there.

const approved: Claim = {
	...snapshot.claims[0]!,
	hosted: undefined,
	approval: { approved: true, approvals: 2, required: 2, vetoedBy: [] },
};
const head = approved.head!;

const vote = (over: Partial<Vote>): Vote => ({
	commit: head,
	reviewer: "githive-checks",
	role: "checks",
	verdict: "reject",
	evidence: "checks failed: npm test exited 1",
	at: ago(10),
	...over,
});

const withVotes = (votes: Vote[]): ChangeHistory => ({ ...historyFixture, votes: [...historyFixture.votes, ...votes] });

const conflict = (over: Partial<MergeCheck> = {}): MergeCheck => ({
	head,
	into: "main",
	branchHead: "9f8e7d6c5b4a",
	clean: false,
	conflicts: ["src/c/index.md"],
	...over,
});

const page = (props: Partial<ChangePageProps>) =>
	visibleText(
		renderToStaticMarkup(
			<ChangePage
				snapshot={snapshot}
				changeId="c-1"
				claim={approved}
				history={historyFixture}
				repo="acme/docs-site"
				tab="conversation"
				merge={async () => ({ ok: true })}
				{...props}
			/>,
		),
	);

/** The Merge button, not the merge box's label or a sentence about merging. */
const MERGE = /\bMerge\b(?! status)/;

describe("merging a change", () => {
	it("offers no Merge for a change whose checks failed on its head", () => {
		const text = page({ history: withVotes([vote({})]) });
		expect(text).toContain("Checks failed");
		expect(text).not.toMatch(MERGE);
	});

	it("offers no Merge for a change a reviewer rejected on its head", () => {
		const text = page({ history: withVotes([vote({ reviewer: "ines", role: "review" })]) });
		expect(text).toContain("Changes requested");
		expect(text).not.toMatch(MERGE);
	});

	it("offers no Merge for a change that conflicts with main", () => {
		const text = page({ history: { ...historyFixture, merge: conflict() } });
		expect(text).toContain("Conflicts with main");
		expect(text).not.toMatch(MERGE);
	});

	it("offers Merge for an approved change with a clean head", () => {
		const text = page({});
		expect(text).toContain("Approved");
		expect(text).toMatch(MERGE);
		expect(page({ history: { ...historyFixture, merge: conflict({ clean: true, conflicts: [] }) } })).toMatch(MERGE);
	});

	it("counts only what was found on its head, not on an earlier push", () => {
		const old = "a0a0a0a0a0a0";
		const text = page({
			history: {
				...withVotes([vote({ commit: old }), vote({ commit: old, reviewer: "ines", role: "review" })]),
				merge: conflict({ head: old }),
			},
		});
		expect(text).toContain("Approved");
		expect(text).toMatch(MERGE);
	});
});
