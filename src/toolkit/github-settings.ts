import type { ClaimRecord, Registry } from "./claims";

// How a repo connected to GitHub works with it (see docs/github-prs.md). In mirror mode main goes to GitHub's main
// after every landing; in pr mode it goes to githive/main, and one standing pull request takes it into GitHub's
// branch. Either way, what GitHub's branch gains comes back as a change claimed by GitHive's service agent
// githive-github, trusted (no review) unless the repo turns trust off.

export type GitHubSync = "mirror" | "pr";
export const GITHUB_SYNCS: readonly GitHubSync[] = ["mirror", "pr"];

/**
 * A new connection's mode. A link made before modes existed has none recorded: it mirrors exactly as it did, and
 * brings nothing of GitHub's back, until a mode is set for it.
 */
export const NEW_CONNECTION_SYNC: GitHubSync = "pr";

/** The connected GitHub repo, how GitHive pushes to it, and whether its changes come back without review. */
export interface GitHubSettings {
	repo: string;
	/** Absent on connections made before modes, which mirror and bring nothing back. */
	sync?: GitHubSync;
	/** Absent means trusted, once a mode is recorded. */
	trust?: boolean;
}

/** GitHive's service agent that brings GitHub's changes back. The githive- names are reserved for its own agents. */
export const GITHUB_AGENT = "githive-github";
/** Its verified identity: hosted agents are stamped as service:githive-<what>. */
export const GITHUB_IDENTITY = "service:githive-github";
/** Where main goes on GitHub in pr mode: the standing pull request's head. */
export const PR_BRANCH = "githive/main";

/** The change githive-github brings GitHub's `commit` in as. */
export const githubChangeId = (commit: string) => `github-${commit.slice(0, 12)}`;

/** The project repo's branch GitHub's `branch` is written to, the source of the change that brings it back. */
export const importedBranch = (branch: string) => `github/${branch}`;

/**
 * Whether a branch is one of GitHive's copies of GitHub's (github/<branch>). They're reserved: the toolkit writes them
 * (force, at each import), so a change landing on one would be pushed away, and only githive-github merges one.
 */
export const isImportedBranch = (name: string) => name.startsWith("github/");

/** The mode a connected repo's GitHub link is in, or null when none is connected. */
export function githubSync(registry: Pick<Registry, "github"> | null | undefined): GitHubSync | null {
	if (!registry?.github) return null;
	return registry.github.sync ?? "mirror";
}

/**
 * Whether GitHub's changes come back to the repo: only for a link with its mode recorded. A link made before modes
 * keeps what it did then, a mirror and nothing more.
 */
export const bringsGitHubBack = (registry: Pick<Registry, "github"> | null | undefined) => !!registry?.github?.sync;

/** Whether a repo takes GitHub's changes without review: they come back, and trust isn't turned off. */
export const trustsGitHub = (registry: Pick<Registry, "github"> | null | undefined) =>
	bringsGitHubBack(registry) && registry!.github!.trust !== false;

/** Whether a claim is githive-github's, bringing a branch of GitHub's back. */
export const isGitHubChange = (claim: Pick<ClaimRecord, "agent" | "source">) =>
	claim.agent === GITHUB_AGENT && !!claim.source?.startsWith("github/");

/** Whether a claim lands without votes as advice sees it. A merge also checks its head is in the import record. */
export const trustedClaim = (
	registry: Pick<Registry, "github"> | null | undefined,
	claim: Pick<ClaimRecord, "agent" | "source">,
) => isGitHubChange(claim) && trustsGitHub(registry);

/** GitHub's default branch as GitHive last read it. */
export interface GitHubSeen {
	github: string;
	branch: string;
	commit: string;
}

/** The standing pull request as GitHive last saw it: a hint for the dashboard; GitHub has the truth. */
export interface KnownPull {
	number: number;
	url: string;
	at: string;
}

/**
 * The job bringing one commit of GitHub's back (see github-inbound.ts): imported as github/<branch>, claimed by
 * githive-github, then merged. Each step is idempotent, so a step tried again finds its work done.
 */
export interface InboundJob {
	repo: string;
	github: string;
	branch: string;
	/** GitHub's commit being brought back, as the import found it. */
	commit: string;
	step: "import" | "claim" | "merge" | "done" | "waiting" | "needs a person" | "given up" | "failed";
	/** github/<branch>'s commit: GitHub's, or one GitHive made joining it to what GitHub had already taken. */
	head?: string;
	/** The GitHive commit whose work GitHub's branch already had when it was imported. */
	base?: string;
	change?: string;
	/** The merge commit, once it landed. */
	merged?: string;
	/** Why it waits, needs a person, was given up or failed; or that GitHive's main had it already. */
	reason?: string;
	/** For a job that waits: the step it goes on from when GitHub's branch is noticed again. */
	resume?: "claim" | "merge";
	attempts: number;
	noticedAt: string;
	updatedAt: string;
}

/** What a repo's GitHubSync object keeps: the job bringing GitHub's changes back, and the pull request. */
export interface GitHubSyncState {
	pull: KnownPull | null;
	job: InboundJob | null;
}

/** The repo's GitHubSync object (see github-sync.ts), as the toolkit reaches it. */
export interface GitHubSyncHandle {
	/**
	 * GitHub's branch is at `seen.commit`: bring it back if GitHive's main lacks it. Returns at once; the job runs in
	 * steps of its own. A commit already brought back, or found on main, is left alone unless `again`.
	 */
	notice(seen: GitHubSeen, again?: boolean): Promise<GitHubSyncState>;
	notePull(pull: KnownPull | null): Promise<void>;
	/**
	 * Someone gave up `change`, GitHub's change, releasing its claim (see giveUpGitHubChange): its job ends there, and
	 * starts again when GitHub's branch moves, or when asked.
	 */
	gaveUp(change: string, reason: string): Promise<void>;
	state(): Promise<GitHubSyncState>;
}
