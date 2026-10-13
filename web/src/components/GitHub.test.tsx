import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoGitHub, RepoSnapshot } from "../api";
import { claimApprovalLabel, claimStatus } from "../lib/claimStatus";
import { repoSnapshot } from "../test/fixtures";
import { ChangePage } from "./ChangePage";
import { GitHubLink } from "./GitHubLink";
import { createDraftStore, draftKey } from "../lib/settingsDrafts";
import { githubDraft, githubInput, GitHubSection } from "./GitHubSettings";
import { ChangeLabels, githubTerms } from "./RepoTabs";

// A repo connected to GitHub shows it by its name: the GitHub repo, and in pr
// mode the standing pull request, or for people who can write a button to open
// it. GitHub's change says where it came from, and that it needs no review while
// the repo trusts GitHub. Admins set the link's mode and trust in Settings.

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
const github = (over: Partial<RepoGitHub> = {}): RepoGitHub => ({
	repo: "acme/shop",
	sync: "pr",
	trust: true,
	inbound: true,
	pull: null,
	...over,
});
const openPull = async () => ({ pr: "u", number: 1, title: "t", opened: true as const });

describe("the GitHub link by a repo's name", () => {
	it("offers to open a pull request to people who can write, and links to it once open", () => {
		const closed = renderToStaticMarkup(<GitHubLink repo="acme/web" github={github()} openPull={openPull} />);
		expect(closed).toContain('href="https://github.com/acme/shop"');
		expect(text(closed)).toContain("Open a pull request on GitHub");
		// Someone who can only read sees no button.
		expect(text(renderToStaticMarkup(<GitHubLink repo="acme/web" github={github()} />))).not.toContain("Open a pull");
		const open = renderToStaticMarkup(
			<GitHubLink
				repo="acme/web"
				github={github({ pull: { number: 7, url: "https://github.com/acme/shop/pull/7" } })}
				openPull={openPull}
			/>,
		);
		expect(open).toContain('href="https://github.com/acme/shop/pull/7"');
		expect(text(open)).toContain("Pull request #7");
		expect(text(open)).not.toContain("Open a pull request");
	});

	it("says a mirror is one, and when GitHub's changes need a person, linking to them", () => {
		expect(text(renderToStaticMarkup(<GitHubLink repo="acme/web" github={github({ sync: "mirror" })} />))).toContain(
			"mirrored",
		);
		const stuck = renderToStaticMarkup(
			<GitHubLink
				repo="acme/web"
				github={github({
					fromGitHub: { step: "needs a person", commit: "c", at: "", change: "github-c", reason: "it conflicts" },
				})}
			/>,
		);
		expect(text(stuck)).toContain("GitHub's changes need a person: it conflicts");
		expect(stuck).toContain("github-c");
	});

	it("offers people who can write to bring GitHub's changes in again once they were given up", () => {
		const givenUp = github({
			fromGitHub: { step: "given up", commit: "c", at: "", change: "github-c", reason: "given up by ana" },
		});
		const again = async () => ({});
		const writer = text(renderToStaticMarkup(<GitHubLink repo="acme/web" github={givenUp} again={again} />));
		expect(writer).toContain("GitHub's changes were given up: given up by ana");
		expect(writer).toContain("Bring them in again");
		expect(text(renderToStaticMarkup(<GitHubLink repo="acme/web" github={givenUp} />))).not.toContain("Bring them");
		// Nothing to ask again while it's done.
		const done = github({ fromGitHub: { step: "done", commit: "c", at: "" } });
		expect(text(renderToStaticMarkup(<GitHubLink repo="acme/web" github={done} again={again} />))).not.toContain(
			"Bring them",
		);
	});
});

describe("GitHub's change", () => {
	type Claim = RepoSnapshot["claims"][number];
	const change: Claim = {
		change: "github-abc",
		agent: "githive-github",
		paths: [],
		intent: "Bring in GitHub's changes (acme/shop main at abc)",
		since: "",
		active: "",
		head: "h",
		source: "github/main",
		trusted: "GitHub's changes: trusted",
		approval: { approved: true, approvals: 0, required: 0, vetoedBy: [] },
	};

	it("can be released from its page by people who can write, like any change", () => {
		const release = async () => ({ ok: true, released: "github-abc" });
		const page = (claim: Claim, withRelease = true) =>
			renderToStaticMarkup(
				<ChangePage
					snapshot={{ ...repoSnapshot, claims: [claim] }}
					changeId={claim.change}
					claim={claim}
					repo="acme/web"
					tab="conversation"
					{...(withRelease ? { release } : {})}
				/>,
			);
		expect(page(change)).toContain('aria-label="More about this change"');
		expect(page(change, false)).not.toContain("More about this change");
		expect(page({ ...change, change: "c-1", agent: "agent-a", source: undefined })).toContain(
			'aria-label="More about this change"',
		);
		// It needs no review: the decision box says so.
		expect(text(page(change))).toContain("No review: GitHub's changes are trusted.");
	});

	it("says it's from GitHub and needs no review while the repo trusts GitHub", () => {
		expect(text(renderToStaticMarkup(<ChangeLabels claim={change} />))).toBe("from GitHub, trusted");
		expect(claimApprovalLabel(change)).toBe("No review: trusted");
		expect(claimStatus(change)).toMatchObject({
			label: "Approved",
			tone: "good",
			description: expect.stringContaining("trusted"),
		});
		const { trusted: _, ...untrusted } = change;
		expect(text(renderToStaticMarkup(<ChangeLabels claim={untrusted} />))).toBe("from GitHub");
	});
});

describe("the GitHub settings", () => {
	it("sends only what changed: a new connection, its mode and trust, or disconnecting it", () => {
		expect(githubInput(githubDraft(undefined), undefined)).toEqual({});
		expect(githubInput({ repo: "acme/shop", sync: "pr", trust: true }, undefined)).toEqual({ github: "acme/shop" });
		expect(githubInput({ repo: "acme/shop", sync: "mirror", trust: false }, undefined)).toEqual({
			github: "acme/shop",
			github_sync: "mirror",
			github_trust: false,
		});
		expect(githubInput({ repo: "acme/shop", sync: "mirror", trust: true }, github())).toEqual({
			github_sync: "mirror",
		});
		expect(githubInput({ repo: " ", sync: "pr", trust: true }, github())).toEqual({ github: "" });
	});

	it("sets a mode for a link made before modes, which brings GitHub's changes back from then on", () => {
		const legacy = github({ sync: "mirror", trust: false, inbound: false });
		expect(githubDraft(legacy)).toEqual({ repo: "acme/shop", sync: "mirror", trust: true });
		expect(githubInput(githubDraft(legacy), legacy)).toEqual({ github_sync: "mirror", github_trust: true });
		// Until someone touches the form, there's nothing to save: saving would change what the link does.
		expect(githubInput(githubDraft(legacy), legacy, false)).toEqual({});
		expect(githubTerms(legacy, "main")).toBe(
			"GitHive pushes main to acme/shop after every landing, as it did before modes: GitHub's changes aren't " +
				"brought back.",
		);
	});

	it("reads the link in words for those who can't change it", () => {
		expect(githubTerms(github(), "main")).toMatch(/through one pull request .* without review\.$/);
		expect(githubTerms(github({ sync: "mirror", trust: false }), "main")).toMatch(
			/pushes main to acme\/shop .* reviewed like any change\.$/,
		);
	});

	const section = (link: RepoGitHub | undefined, drafts = createDraftStore()) =>
		renderToStaticMarkup(
			<GitHubSection
				repo="acme/web"
				branch="main"
				snapshot={{ policy: { required: 1, vetoes: [] }, verify: [], github: link }}
				save={async () => ({}) as never}
				drafts={drafts}
				options={{ roles: [], holders: [] }}
			/>,
		);

	it("shows a connection as it is, with Change… and Disconnect, asked first", () => {
		const html = section(github({ pull: { number: 128, url: "https://github.com/acme/shop/pull/128" } }));
		expect(text(html)).toContain("Connected to acme/shop · Pull request #128");
		expect(text(html)).toContain("Change…");
		expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Disconnect<\/button>/);
		// No fields until Change… opens them.
		expect(html).not.toContain('id="github-repo"');
	});

	it("chooses how GitHive's work reaches GitHub from cards that say what each means", () => {
		const drafts = createDraftStore();
		const form = { ...githubDraft(github()), editing: true, touched: false };
		drafts.set(draftKey("acme/web", "github"), { draft: form, base: { ...form, editing: false }, dirty: false });
		const html = section(github(), drafts);
		expect(html).toMatch(/name="github-sync" checked="" value="pr"/);
		expect(text(html)).toContain("Nothing reaches GitHub's main until someone merges it there.");
		expect(text(html)).toContain("Pushed to main After every landing GitHive pushes main to GitHub");
		expect(text(section(undefined))).toContain("Connect");
	});
});
