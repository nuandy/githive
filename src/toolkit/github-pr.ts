import { GITHUB_AGENT, PR_BRANCH } from "./github-settings";
import type { LandedChange } from "./history";

// The standing pull request's title and body (see docs/github-prs.md): what landed on GitHive since GitHub's branch
// last took GitHive's work, each change with its intent, its agent and its reviewers' evidence, as the merge
// commits tell it. GitHub's merges of earlier pull requests came back as githive-github's changes, which are
// GitHub's own and left out.

/** How many changes the body lists; the rest are counted. GitHub caps a body at 65,536 characters. */
const LISTED_MOST = 100;
const EVIDENCE_MOST = 200;

export interface PullStory {
	title: string;
	body: string;
	/** How many changes it describes. */
	changes: number;
}

/**
 * The landed changes GitHub's branch doesn't have, newest first: those after `takenAt`, the GitHive commit whose
 * work it last took, leaving out githive-github's.
 */
export function untaken(landed: LandedChange[], takenAt: string | undefined): LandedChange[] {
	const changes: LandedChange[] = [];
	for (const change of landed) {
		if (change.commit === takenAt) break;
		if (change.agent !== GITHUB_AGENT) changes.push(change);
	}
	return changes;
}

const oneLine = (text: string, most = Number.POSITIVE_INFINITY) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat;
};

/** The pull request's title and body for `changes`, going into GitHub's `branch`. */
export function pullStory(changes: LandedChange[], branch: string): PullStory {
	const count = changes.length;
	const title = `GitHive: ${count} change${count === 1 ? "" : "s"}`;
	const lines = [
		`What landed on GitHive since \`${branch}\` last took GitHive's work, newest first. Merge it the usual ` +
			"way, by merge commit, squash or rebase: GitHive brings the merge back as its own change, so the next " +
			"pull request shows only what's new.",
		"",
	];
	for (const change of changes.slice(0, LISTED_MOST)) {
		lines.push(`- **${oneLine(change.intent ?? change.title)}** (\`${change.change}\`, by ${change.agent})`);
		for (const review of change.reviews.filter((entry) => entry.verdict === "approve"))
			lines.push(`  - reviewed by ${review.reviewer} (${review.role}): ${oneLine(review.evidence, EVIDENCE_MOST)}`);
	}
	if (count > LISTED_MOST) lines.push(`- …and ${count - LISTED_MOST} more`);
	lines.push(
		"",
		`_GitHive pushes \`${PR_BRANCH}\` after every landing, so this pull request updates itself. Its description is ` +
			"rewritten by `github_pr` with `refresh`, or from GitHive's dashboard._",
	);
	return { title, body: lines.join("\n"), changes: count };
}
