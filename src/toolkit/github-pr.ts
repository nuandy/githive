import { GITHUB_AGENT, PR_BRANCH } from "./github-settings";
import { type LandedChange, landedSince } from "./history";
import type { ToolContext } from "./mcp";

// The standing pull request's title and body (see docs/github-prs.md): what landed on GitHive since GitHub's branch
// last took GitHive's work, each change with its intent, its agent and its reviewers' evidence, as the merge
// commits tell it. GitHub's merges of earlier pull requests came back as githive-github's changes, which are
// GitHub's own and left out.

/** How many changes the body lists, newest first; the rest are counted. GitHub caps a body at 65,536 characters. */
export const LISTED_MOST = 50;
/** How long an intent, a piece of evidence or a name may run in the body. */
const INTENT_MOST = 200;
const EVIDENCE_MOST = 200;
const NAME_MOST = 100;

export interface PullStory {
	title: string;
	body: string;
	/** How many changes it describes, or null when GitHive can't tell which GitHub's branch lacks. */
	changes: number | null;
}

/** What GitHub's branch lacks, as the story tells it. */
export interface Untaken {
	/** The GitHive commit whose work GitHub's branch last took; null when it's no commit of GitHive's main. */
	since: string | null;
	/** How many changes landed after it, githive-github's left out. */
	count: number;
	/** The newest of them, at most LISTED_MOST, with their reviews. */
	listed: LandedChange[];
}

/** The landed changes that are GitHive's work, leaving out githive-github's, which brought GitHub's own back. */
export const untaken = (landed: LandedChange[]) => landed.filter((change) => change.agent !== GITHUB_AGENT);

/** The story of what landed on GitHive's main since `takenAt`, the GitHive commit whose work GitHub's branch took. */
export async function pullStoryAt(ctx: ToolContext, repo: string, takenAt: string, branch: string) {
	const read = await landedSince(ctx, repo, takenAt, (landed) => untaken(landed).slice(0, LISTED_MOST));
	return pullStory({ since: read.since, count: untaken(read.landed).length, listed: read.listed }, branch);
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

/**
 * The pull request's title and body for what GitHub's `branch` lacks. When GitHive can't tell where GitHub's branch
 * last took its work (its head is no commit of GitHive's main: pushed there directly, or a merge not yet brought
 * back), it says so and lists nothing, rather than every change since GitHive started.
 */
export function pullStory(untakenWork: Untaken, branch: string): PullStory {
	const { since, count, listed } = untakenWork;
	const merging =
		"Merge it the usual way, by merge commit, squash or rebase: GitHive brings the merge back as its own change, so " +
		"the next pull request shows only what's new.";
	const footer =
		`_GitHive pushes \`${PR_BRANCH}\` after every landing, so this pull request updates itself. Its description is ` +
		"rewritten by `github_pr` with `refresh`, or from GitHive's dashboard._";
	if (since === null)
		return {
			title: `GitHive: changes since ${branch} last took GitHive's work`,
			body: [
				`What landed on GitHive since \`${branch}\` last took GitHive's work. GitHub's \`${branch}\` is at a commit ` +
					"GitHive's main doesn't have (pushed there directly, or a merge GitHive hasn't brought back yet), so " +
					"GitHive can't tell which of its changes it lacks and lists none here. It brings that commit back now; " +
					`refreshing this description after lists them. ${merging}`,
				"",
				footer,
			].join("\n"),
			changes: null,
		};
	const at = `\`${since.slice(0, 8)}\``;
	const lines = [
		`What landed on GitHive since \`${branch}\` last took GitHive's work (${at}), newest first. ${merging}`,
		"",
	];
	// Everything an agent wrote (intents, names, roles, evidence) goes in as inert text: see inert.
	for (const change of listed.slice(0, LISTED_MOST)) {
		const intent = inert(change.intent ?? change.title, INTENT_MOST);
		lines.push(`- **${intent}** (${inert(change.change)}, by ${inert(change.agent)})`);
		for (const review of change.reviews.filter((entry) => entry.verdict === "approve")) {
			const evidence = inert(review.evidence, EVIDENCE_MOST);
			lines.push(`  - reviewed by ${inert(review.reviewer)} (${inert(review.role)}): ${evidence}`);
		}
	}
	const shown = Math.min(listed.length, LISTED_MOST);
	if (count > shown) lines.push(`- …and ${count - shown} more since ${at}`);
	lines.push("", footer);
	return { title: `GitHive: ${count} change${count === 1 ? "" : "s"}`, body: lines.join("\n"), changes: count };
}
