import { GITHUB_AGENT, PR_BRANCH } from "./github-settings";
import type { LandedChange } from "./history";

// The standing pull request's title and body (see docs/github-prs.md): what landed on GitHive since GitHub's branch
// last took GitHive's work, each change with its intent, its agent and its reviewers' evidence, as the merge
// commits tell it. GitHub's merges of earlier pull requests came back as githive-github's changes, which are
// GitHub's own and left out.

/** How many changes the body lists; the rest are counted. GitHub caps a body at 65,536 characters. */
const LISTED_MOST = 100;
/** How long an intent, a piece of evidence or a name may run in the body. */
const INTENT_MOST = 200;
const EVIDENCE_MOST = 200;
const NAME_MOST = 100;

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

const oneLine = (text: string, most: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat;
};

/**
 * Text an agent wrote, made inert for GitHub: one line, capped, in a code span. GitHub acts on a pull request's body
 * (a closing keyword like "Fixes #12" closes the issue when the pull request merges, "@user" and "@org/team" notify
 * people, and links, images and HTML render), but not on anything inside code, which it shows as written.
 */
export function inert(text: string, most = NAME_MOST): string {
	const flat = oneLine(text, most);
	if (!flat) return "(none)";
	// A code span's fence is longer than any run of backticks inside it, and padded if the text starts or ends with one.
	const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
	return `${fence}${pad}${flat}${pad}${fence}`;
}

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
	// Everything an agent wrote (intents, names, roles, evidence) goes in as inert text: see inert.
	for (const change of changes.slice(0, LISTED_MOST)) {
		const intent = inert(change.intent ?? change.title, INTENT_MOST);
		lines.push(`- **${intent}** (${inert(change.change)}, by ${inert(change.agent)})`);
		for (const review of change.reviews.filter((entry) => entry.verdict === "approve")) {
			const evidence = inert(review.evidence, EVIDENCE_MOST);
			lines.push(`  - reviewed by ${inert(review.reviewer)} (${inert(review.role)}): ${evidence}`);
		}
	}
	if (count > LISTED_MOST) lines.push(`- …and ${count - LISTED_MOST} more`);
	lines.push(
		"",
		`_GitHive pushes \`${PR_BRANCH}\` after every landing, so this pull request updates itself. Its description is ` +
			"rewritten by `github_pr` with `refresh`, or from GitHive's dashboard._",
	);
	return { title, body: lines.join("\n"), changes: count };
}
