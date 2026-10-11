import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoGitHub, RepoSnapshot } from "../api";
import { claimApprovalLabel, claimStatus } from "../lib/claimStatus";
import { GitHubLink } from "./GitHubLink";
import { githubDraft, githubInput } from "./GitHubSettings";
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

	it("says it's from GitHub and needs no review while the repo trusts GitHub", () => {
		expect(text(renderToStaticMarkup(<ChangeLabels claim={change} />))).toBe("from GitHub, trusted");
		expect(claimApprovalLabel(change)).toBe("No review: trusted");
		expect(claimStatus(change)).toMatchObject({ label: "Trusted", tone: "good" });
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
});
