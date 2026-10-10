import type { ChangeHistory } from "../api";
import { identityName } from "./agent";
import type { ChangeStatus } from "./changeStatus";
import { timeOf } from "./model";
import { href } from "./routes";
import type { TimelineItem } from "./timeline";

// A change's Conversation, from its history in Git: claimed,
// each commit pushed, each vote, and how it ended (merged or released).

export type Vote = ChangeHistory["votes"][number];

/** A vote as a review card: the reviewer's name, the role, the evidence. */
export function voteAsReview(vote: Vote) {
	const evidence = (vote.evidence ?? "").trim();
	const firstLine = evidence.split("\n")[0];
	const short = firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
	return {
		reviewer: vote.role,
		by: vote.reviewer ? `agent:${vote.reviewer}` : vote.by,
		head: vote.commit,
		verdict: vote.verdict,
		summary: short,
		...(evidence && evidence !== short ? { evidence } : {}),
		at: vote.at,
	};
}

/** How it ended, if it did: merged (with the merge commit) or released. */
export function changeEnding(history: Pick<ChangeHistory, "claim" | "released">) {
	if (history.claim) return null;
	const merged = history.released.find((r) => r.mergedAs);
	if (merged) return { kind: "merged" as const, release: merged };
	const last = [...history.released].sort((a, b) => (timeOf(b.at) ?? 0) - (timeOf(a.at) ?? 0))[0];
	return last ? { kind: "released" as const, release: last } : null;
}

export function historyStatus(history: Pick<ChangeHistory, "claim" | "released">): ChangeStatus | null {
	const ending = changeEnding(history);
	if (!ending) return null;
	return ending.kind === "merged"
		? { kind: "merged", label: "Merged", tone: "good", description: "Merged." }
		: {
				kind: "abandoned",
				label: "Released",
				tone: "neutral",
				description: `Its claim was released: ${ending.release.reason}`,
			};
}

export function buildTimeline(history: ChangeHistory, repo: string): TimelineItem[] {
	const items: TimelineItem[] = [];
	const claim = history.claim;
	const release = history.released[0];
	const opener = claim?.agent || release?.agent || identityName(claim?.by);
	const paths = claim?.paths ?? [];
	items.push({
		key: "claimed",
		kind: "opened",
		at: claim?.since,
		tone: "accent",
		text: `${opener ? `${opener} ` : ""}claimed ${paths.length ? paths.join(", ") : "its paths"}`,
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
		items.push({
			key: `vote:${index}`,
			kind: "review",
			at: vote.at,
			tone: vote.verdict === "approve" ? "good" : "bad",
			text: `${vote.reviewer} ${vote.verdict === "approve" ? "approved" : "requested changes"}`,
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
			text: `merged into ${history.branch || "main"} as`,
			commit: sha,
			commitHref: href.code(repo, "", sha),
		});
	} else if (ending) {
		const r = ending.release;
		items.push({
			key: "released",
			kind: "abandoned",
			at: r.at,
			tone: "neutral",
			text: `${r.agent ? `${r.agent} ` : ""}released the claim${r.stale ? " (it had gone stale)" : ""}`,
			...(r.reason ? { body: r.reason } : {}),
		});
	}
	const order = (item: TimelineItem) => timeOf(item.at) ?? (item.kind === "opened" ? -Infinity : Infinity);
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => order(a.item) - order(b.item) || a.index - b.index)
		.map(({ item }) => item);
}
