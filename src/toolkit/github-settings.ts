import type { ClaimRecord, Registry } from "./claims";

// How a repo connected to GitHub works with it (see docs/github-prs.md). In mirror mode main goes to GitHub's main
// after every landing; in pr mode it goes to githive/main, and one standing pull request takes it into GitHub's
// branch. Either way, what GitHub's branch gains comes back as a change claimed by GitHive's service agent
// githive-github, trusted (no review) unless the repo turns trust off.

export type GitHubSync = "mirror" | "pr";
export const GITHUB_SYNCS: readonly GitHubSync[] = ["mirror", "pr"];

/** A new connection's mode. Repos connected before modes existed have none recorded and mirror. */
export const NEW_CONNECTION_SYNC: GitHubSync = "pr";

/** The connected GitHub repo, how GitHive pushes to it, and whether its changes come back without review. */
export interface GitHubSettings {
	repo: string;
	/** Absent on connections made before modes, which mirror. */
	sync?: GitHubSync;
	/** Absent means trusted. */
	trust?: boolean;
}

/** GitHive's service agent that brings GitHub's changes back. The githive- names are reserved for its own agents. */
export const GITHUB_AGENT = "githive-github";
/** Its verified identity: hosted agents are stamped as service:githive-<what>. */
export const GITHUB_IDENTITY = "service:githive-github";
/** Where main goes on GitHub in pr mode: the standing pull request's head. */
export const PR_BRANCH = "githive/main";

/** The project repo's branch GitHub's `branch` is written to, the source of the change that brings it back. */
export const importedBranch = (branch: string) => `github/${branch}`;

/** The mode a connected repo's GitHub link is in, or null when none is connected. */
export function githubSync(registry: Pick<Registry, "github"> | null | undefined): GitHubSync | null {
	if (!registry?.github) return null;
	return registry.github.sync ?? "mirror";
}

/** Whether a repo takes GitHub's changes without review: connected, and trust not turned off. */
export const trustsGitHub = (registry: Pick<Registry, "github"> | null | undefined) =>
	!!registry?.github && registry.github.trust !== false;

/** Whether a claim is githive-github's, bringing a branch of GitHub's back. */
export const isGitHubChange = (claim: Pick<ClaimRecord, "agent" | "source">) =>
	claim.agent === GITHUB_AGENT && !!claim.source?.startsWith("github/");

/** Whether a claim lands without votes as advice sees it. A merge also checks its head is in the import record. */
export const trustedClaim = (
	registry: Pick<Registry, "github"> | null | undefined,
	claim: Pick<ClaimRecord, "agent" | "source">,
) => isGitHubChange(claim) && trustsGitHub(registry);
