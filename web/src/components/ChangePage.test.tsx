import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeDiff, ChangeHistory, MergeCheck, RepoLanding, RepoSnapshot } from "../api";
import type { Claim, Vote } from "../lib/claimStatus";
import { ago, historyFixture, inlineText, repoSnapshot as snapshot, visibleText } from "../test/fixtures";
import { landFailure } from "./ChangeActions";
import { ChangePage, type ChangePageProps } from "./ChangePage";

// A change's page: where it stands, and what a person may do about it from there.

const approved: Claim = {
	...snapshot.claims[0]!,
	hosted: undefined,
	approval: { approved: true, approvals: 2, required: 2, vetoedBy: [], awaiting: [] },
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

const render = (props: Partial<ChangePageProps>) =>
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
	);
const page = (props: Partial<ChangePageProps>) => visibleText(render(props));

/** The decision box's markup alone. */
const box = (html: string) => html.match(/<section id="decide"[\s\S]*?<\/section>/)?.[0] ?? "";

/** The Land now button, not "Landed" or "Landing" in a sentence. */
const LAND = /Land now/;

describe("landing a change", () => {
	it("offers no Land now for a change whose checks failed on its head, and shows what failed", () => {
		const html = render({ history: withVotes([vote({})]) });
		expect(visibleText(html)).toContain("Checks failed");
		expect(visibleText(box(html))).toContain("npm test exited 1");
		expect(visibleText(html)).not.toMatch(LAND);
	});

	it("offers no Land now for a change a reviewer rejected on its head", () => {
		const text = page({ history: withVotes([vote({ reviewer: "ines", role: "review" })]) });
		expect(text).toContain("Changes requested");
		expect(text).not.toMatch(LAND);
	});

	it("offers no Land now for a change that conflicts with main", () => {
		const html = render({ history: { ...historyFixture, merge: conflict() } });
		expect(visibleText(box(html))).toContain("Conflicts with main");
		expect(visibleText(html)).not.toMatch(LAND);
	});

	it("offers Land now for an approved change with a clean head, in the decision box", () => {
		const html = render({});
		expect(visibleText(box(html))).toContain("Approved");
		expect(visibleText(box(html))).toMatch(LAND);
		expect(page({ history: { ...historyFixture, merge: conflict({ clean: true, conflicts: [] }) } })).toMatch(LAND);
		// Without the right to land, it's not offered.
		expect(page({ merge: undefined })).not.toMatch(LAND);
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
		expect(text).toMatch(LAND);
	});

	it("says Landing, not Approved, while its head is being checked to land, and offers nothing to do", () => {
		const landing: RepoLanding = {
			branch: "main",
			checking: { base: "b", since: ago(2), changes: [{ change: "c-1", head, agent: "agent-c" }] },
			recent: [],
		};
		const text = page({ landing });
		expect(text).toContain("Landing");
		expect(text).not.toContain("Approved");
		expect(text).not.toMatch(LAND);
		expect(visibleText(box(render({ landing })))).toContain("Being checked to land");
	});

	it("says why it couldn't land in a sentence: the server's words after the colon, as they came", () => {
		expect(landFailure(new Error("checks failed: npm test exited 1"))).toEqual({
			ok: false,
			text: "It couldn't land: checks failed: npm test exited 1.",
		});
		expect(landFailure(new Error("no change c-9."))).toEqual({ ok: false, text: "It couldn't land: no change c-9." });
	});

	it("says checks run after approval when none ran yet, naming them", () => {
		const unapproved = { ...approved, approval: { approved: false, approvals: 1, required: 2, vetoedBy: [] } };
		expect(visibleText(box(render({ claim: unapproved })))).toContain("Checks run after approval: npm test");
	});
});

describe("the decision box", () => {
	const policy: RepoSnapshot["policy"] = { required: 2, vetoes: ["security"] };
	const waiting: Claim = {
		...approved,
		approval: { approved: false, approvals: 1, required: 2, vetoedBy: [], awaiting: ["security"] },
	};

	it("lists approvals per role and who gave each, in a line each", () => {
		const history = withVotes([vote({ reviewer: "rev-2", role: "review", verdict: "approve", evidence: "ok" })]);
		const text = visibleText(box(render({ claim: waiting, history, snapshot: { ...snapshot, policy } })));
		expect(text).toMatch(/review: 1 of 2 · rev-1, rev-2/);
		expect(text).toMatch(/security: waiting/);
	});

	it("is the box the page scrolls to and focuses", () => {
		expect(box(render({}))).toMatch(/^<section id="decide" tabindex="-1"/);
	});

	it("offers a vote to a reader who can and hasn't, and nothing once they have", () => {
		const api = { vote: async () => ({}) };
		const reader = { by: "person:ana", teams: [] };
		const asked = (votes: Vote[] = []) =>
			visibleText(
				box(
					render({ claim: waiting, api, canVote: true, merge: undefined, access: reader, history: withVotes(votes) }),
				),
			);
		expect(asked()).toMatch(/\bVote\b/);
		const mine = vote({ reviewer: "person:ana", by: "person:ana", role: "review", verdict: "approve" });
		expect(asked([mine])).not.toMatch(/\bVote\b/);
		expect(visibleText(render({ claim: waiting, api, access: reader, history: withVotes([mine]) }))).toContain(
			"You approved b1c2d3e",
		);
	});

	it("says how many open changes its code meets", () => {
		const awareness: NonNullable<ChangeHistory["awareness"]> = {
			change: "c-1",
			agent: "agent-c",
			branch: "main",
			head,
			base: "b",
			at: 1,
			alters: [],
			uses: [],
			usedBy: [
				{
					file: "src/c/x.ts",
					altered: { name: "x", change: "removed" },
					imported: "x",
					at: [],
					other: { by: "agent-d", change: "c-2" },
				},
			],
			alteredBy: [],
		};
		const claims = [approved, { ...approved, change: "c-2", agent: "agent-d" }];
		const html = render({ snapshot: { ...snapshot, claims }, history: { ...historyFixture, awareness } });
		expect(visibleText(box(html))).toContain("Meets 1 other open change");
	});

	it("offers to release the claim to people who can write, saying what that does", () => {
		const release = async () => ({ ok: true });
		expect(box(render({ release }))).toContain('aria-label="More about this change"');
		expect(box(render({}))).not.toContain("More about this change");
	});

	it("says how a landed or released change ended", () => {
		const landed: ChangeHistory = {
			...historyFixture,
			claim: null,
			released: [{ reason: "merged", at: ago(30), agent: "agent-c", mergedAs: "1a2b3c4d5e6f" }],
		};
		expect(visibleText(box(render({ claim: undefined, history: landed })))).toMatch(/Landed on main as 1a2b3c4/);
		const released: ChangeHistory = {
			...historyFixture,
			claim: null,
			released: [{ reason: "It needs package.json", at: ago(30), agent: "agent-c", by: "person:ana" }],
		};
		const text = inlineText(box(render({ claim: undefined, history: released, access: { by: "person:ana" } })));
		expect(text).toContain("Released by you: It needs package.json");
	});
});

describe("an agent's question", () => {
	const asking: Claim = {
		...snapshot.claims[0]!,
		attention: { reason: "reviewers disagree on the cache size", agent: "agent-c", at: ago(15) },
	};
	const voteApi = { vote: async () => ({}) };

	it("asks the reader to vote only when a vote form is on the page", () => {
		const text = page({ claim: asking, canVote: true, api: voteApi });
		expect(text).toContain("agent-c asks you");
		expect(text).toContain("Decide with your vote");
	});

	it("tells a reader who can't vote that it waits on a person, not on them", () => {
		for (const text of [page({ claim: asking, canVote: false, api: voteApi }), page({ claim: asking })]) {
			expect(text).toContain("agent-c asks a person");
			expect(text).toContain("A person who can review in acme/docs-site answers it by voting.");
			expect(text).not.toMatch(/asks you|your vote/);
		}
	});

	it("says there's nothing to vote on before anything is pushed, and offers a release where a vote can't answer", () => {
		const text = page({ claim: { ...asking, head: null }, canVote: true, api: voteApi });
		expect(text).toContain("Nothing is pushed yet");
		expect(text).not.toMatch(/asks you|your vote/);
		const builder: Claim = {
			...asking,
			head: null,
			agent: "githive-builder",
			attention: { agent: "githive-builder", at: ago(5), reason: "GitHive's builder failed: needs package.json" },
		};
		const release = async () => ({ ok: true });
		expect(page({ claim: builder, api: voteApi, release })).toMatch(/Release claim/);
		expect(page({ claim: builder, api: voteApi })).not.toMatch(/Release claim/);
	});
});

describe("its files", () => {
	const diff: ChangeDiff = {
		change: "c-1",
		of: "head",
		base: "a0a0a0a0a0a0",
		head,
		total: 2,
		files: [
			{ path: "src/c/index.md", status: "modified", added: 3, removed: 1, hunks: [] },
			{ path: "package.json", status: "modified", added: 1, removed: 0, outside: true, hunks: [] },
		],
	};

	it("has a Files tab beside Conversation and Commits, counting them", () => {
		const html = render({ diff });
		expect(html).toMatch(/Files<\/span><span data-slot="counter"[^>]*>2<\/span>/);
		expect(html).toContain('href="#/repos/acme/docs-site/changes/c-1/files"');
	});

	it("shows them on the Files tab, beside the decision box", () => {
		const html = render({ diff, tab: "files", file: "package.json" });
		expect(visibleText(html)).toContain("2 files changed");
		expect(visibleText(html)).toContain("outside its claim");
		expect(box(html)).toContain("Approved");
	});
});

describe("its details", () => {
	it("shows people's handles, not their hashes, and truncates claimed paths in the middle", () => {
		const claim: Claim = {
			...approved,
			agent: "githive-builder",
			by: "person:e5c1b970aaaa",
			paths: ["src/components/checkout/CartDrawer.tsx"],
		};
		const html = render({ claim, access: { by: "person:e5c1b970aaaa" } });
		expect(visibleText(html)).not.toContain("person e5c1b970");
		expect(visibleText(html)).toContain("for you");
		// The file name kept whole, the folders cut first, and the whole path said to screen readers.
		expect(html).toMatch(
			/<span aria-hidden="true" class="[^"]*truncate[^"]*">src\/components\/checkout\/<\/span><span aria-hidden="true" class="[^"]*shrink-0[^"]*">CartDrawer\.tsx<\/span>/,
		);
		expect(html).toContain('<span class="sr-only">src/components/checkout/CartDrawer.tsx</span>');
	});

	it("never says merge for landing", () => {
		const text = page({});
		expect(text).not.toMatch(/\bmerg(e|es|ed|ing)\b/i);
	});
});
