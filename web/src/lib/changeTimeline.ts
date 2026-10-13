import type { ChangeHistory } from "../api";
import { identityName } from "./agent";
import type { ChangeStatus } from "./changeStatus";
import { timeOf } from "./model";
import { href } from "./routes";
import { STATES } from "./status";
import type { TimelineItem } from "./timeline";

// A change's Conversation, from its history in Git: claimed,
// each commit pushed, each vote, and how it ended (landed or released).

export type Vote = ChangeHistory["votes"][number];
type Release = ChangeHistory["released"][number];

/** A vote as a review card: the reviewer's name, the role, the evidence. */
export function voteAsReview(vote: Vote) {
	const evidence = (vote.evidence ?? "").trim();
	const firstLine = evidence.split("\n")[0] ?? "";
	const short = firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
	return {
		reviewer: vote.role,
		by: vote.reviewer ? `agent:${vote.reviewer}` : vote.by,
		head: vote.commit,
		verdict: vote.verdict,
		summary: short,
		...(evidence && evidence !== short ? { evidence } : {}),
		...(vote.thin ? { thin: true } : {}),
		at: vote.at,
	};
}

/** How it ended, if it did: merged (with the merge commit) or released. */
export function changeEnding(history: Pick<ChangeHistory, "claim" | "released">) {
	if (history.claim) return null;
	const merged = history.released.find((release) => release.mergedAs);
	if (merged) return { kind: "merged" as const, release: merged };
	const newestFirst = (a: Release, b: Release) => (timeOf(b.at) ?? 0) - (timeOf(a.at) ?? 0);
	const last = [...history.released].sort(newestFirst)[0];
	return last ? { kind: "released" as const, release: last } : null;
}

/** How a change that's no longer in force ended, as its state (see status.ts): landed, or released. */
export function historyStatus(history: Pick<ChangeHistory, "claim" | "released">): ChangeStatus | null {
	const ending = changeEnding(history);
	if (!ending) return null;
	const kind = ending.kind === "merged" ? "landed" : "released";
	const { label, tone } = STATES[kind];
	const description = kind === "landed" ? "Landed." : `Its claim was released: ${ending.release.reason}`;
	return { kind, label, tone, description };
}

export function buildTimeline(history: ChangeHistory, repo: string): TimelineItem[] {
	const items: TimelineItem[] = [];
	const claim = history.claim;
	const release = history.released[0];
	const opener = claim?.agent || release?.agent || identityName(claim?.by);
	const paths = claim?.paths ?? [];
	const openerPrefix = opener ? `${opener} ` : "";
	const claimedPaths = paths.length ? paths.join(", ") : "its paths";
	items.push({
		key: "claimed",
		kind: "opened",
		at: claim?.since,
		tone: "accent",
		text: `${openerPrefix}claimed ${claimedPaths}`,
		...(claim?.intent ? { body: claim.intent } : {}),
	});
	for (const commit of [...history.commits].reverse()) {
		items.push({
			key: `commit:${commit.commit}`,
			kind: "pushed",
			at: commit.at,
			tone: "neutral",
			text: `${commit.author || "someone"} pushed a commit`,
			commit: commit.commit,
			commitHref: href.code(repo, "", commit.commit),
			...(commit.message ? { body: commit.message } : {}),
		});
	}
	history.votes.forEach((vote, index) => {
		const review = voteAsReview(vote);
		const approved = vote.verdict === "approve";
		const verdictWords = approved ? "approved" : "requested changes";
		items.push({
			key: `vote:${index}`,
			kind: "review",
			at: vote.at,
			tone: approved ? "good" : "bad",
			text: `${vote.reviewer} ${verdictWords}`,
			commit: vote.commit,
			review,
		});
	});
	const ending = changeEnding(history);
	if (ending?.kind === "merged") {
		const sha = ending.release.mergedAs!;
		items.push({
			key: "merged",
			kind: "merged",
			at: ending.release.at,
			tone: "good",
			text: `landed on ${history.branch || "main"} as`,
			commit: sha,
			commitHref: href.code(repo, "", sha),
		});
	} else if (ending) {
		const finalRelease = ending.release;
		const agentPrefix = finalRelease.agent ? `${finalRelease.agent} ` : "";
		const staleNote = finalRelease.stale ? " (it had gone stale)" : "";
		items.push({
			key: "released",
			kind: "abandoned",
			at: finalRelease.at,
			tone: "neutral",
			text: `${agentPrefix}released the claim${staleNote}`,
			...(finalRelease.reason ? { body: finalRelease.reason } : {}),
		});
	}
	const order = (item: TimelineItem) => timeOf(item.at) ?? (item.kind === "opened" ? -Infinity : Infinity);
	const sorted = items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => order(a.item) - order(b.item) || a.index - b.index)
		.map(({ item }) => item);
	// Attempts carry no time: they go after everything else that happened, and before how it ended.
	const ended = sorted.findIndex((item) => item.kind === "merged" || item.kind === "abandoned");
	sorted.splice(ended < 0 ? sorted.length : ended, 0, ...attemptItems(history.attempts ?? []));
	return sorted;
}

/** How an attempt's line starts, as the server words it (see conflictLine and putOut). */
const CONFLICT_ON = "conflict on ";
const CHECKS_FAILED = "checks failed";

/** Each earlier attempt to land, oldest first: what refused it, in the line noted for the merge commit's story. */
export function attemptItems(attempts: string[]): TimelineItem[] {
	return attempts.map((line, index) => {
		let what = "was refused";
		if (line.startsWith(CONFLICT_ON)) what = "conflicted with its branch";
		else if (line.startsWith(CHECKS_FAILED)) what = "failed its checks";
		return { key: `attempt:${index}`, kind: "attempt", tone: "warn", text: `an attempt to land ${what}`, body: line };
	});
}
