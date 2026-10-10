import { FORMAT_TRAILER, RECORD_FORMAT } from "../record-format";
import { mergeStampPayload } from "./audit";
import type { Stamper } from "./stamp";

// A merge commit's message: why the change was made and who reviewed it, then
// the trailers the audit reads and GitHive's stamp over them. Made wherever a
// batch lands (the repo's Gate, or in memory), so both write exactly the same
// thing. The intent and the evidence are agents' own words, so they stay above
// the trailer block, which is the only part the audit reads.

/** What a merge records: the change, its agent, the records it checked, and what its checks ran on. */
export interface MergeClaim {
	/** Main before the merge (its first parent). */
	base: string;
	/** The change's commit merged (its second parent). */
	head: string;
	change: string;
	author: string;
	by?: string;
	claimsTip: string;
	votesTip: string;
	/** The main the checks passed on. */
	testedOn?: string;
	/** Every change checked with it, in landing order, itself among them (absent: checked alone). */
	testedWith?: string[];
	/** Why the change was made, as its claim says. */
	intent?: string;
	/** The approvals its head landed with. */
	reviews?: MergeReview[];
}

export interface MergeReview {
	reviewer: string;
	role: string;
	evidence: string;
}

const SUBJECT_MOST = 72;
const BODY_WIDTH = 72;
const EVIDENCE_MOST = 200;
const INTENT_TRAILER_MOST = 200;

/** Agent-written text as one line, cut to `most` characters. */
function oneLine(text: string, most: number) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat;
}

/** Text wrapped at word boundaries, so the message reads well in `git log`. */
function wrapped(text: string, width = BODY_WIDTH) {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	return line ? [...lines, line] : lines;
}

/** The subject and body: the change's intent, and each approval's evidence. */
function storyOf(claimed: MergeClaim) {
	const merged = `Merge ${claimed.change} by ${claimed.author}`;
	const intent = claimed.intent ? oneLine(claimed.intent, Number.POSITIVE_INFINITY) : "";
	if (!intent) return [merged, ""];
	const lines = [oneLine(intent, SUBJECT_MOST), "", `${merged}.`];
	if (intent.length > SUBJECT_MOST) lines.push("", ...wrapped(intent));
	const reviews = claimed.reviews ?? [];
	if (reviews.length) {
		lines.push("", "Reviewed by:");
		for (const review of reviews) {
			const evidence = oneLine(review.evidence, EVIDENCE_MOST);
			lines.push(`- ${review.reviewer} (${review.role}): ${evidence}`);
		}
	}
	return [...lines, ""];
}

export async function mergeMessage(claimed: MergeClaim, stamper?: Stamper) {
	// No votes record at all (no review asked for, none cast): no trailer, and the stamp over none, as the audit reads it.
	// An empty trailer reads back as none, so a stamp over "" never verified: 200 merges without review all unverified.
	const signed = { ...claimed, votesTip: claimed.votesTip || undefined };
	return [
		...storyOf(claimed),
		`GitHive-Change: ${claimed.change}`,
		...(claimed.intent ? [`GitHive-Intent: ${oneLine(claimed.intent, INTENT_TRAILER_MOST)}`] : []),
		`${FORMAT_TRAILER}: ${RECORD_FORMAT}`,
		`GitHive-Agent: ${claimed.author}`,
		`GitHive-Claims: ${claimed.claimsTip}`,
		...(signed.votesTip ? [`GitHive-Votes: ${signed.votesTip}`] : []),
		// Which main the checks passed on.
		...(claimed.testedOn ? [`GitHive-Tested: ${claimed.testedOn}`] : []),
		// The changes checked together on it, in landing order: exactly these landed on it, in one push.
		...(claimed.testedWith?.length ? [`GitHive-Tested-With: ${claimed.testedWith.join(" ")}`] : []),
		// Who asked for it, as Access verified them, and GitHive's stamp over all of the above.
		...(stamper ? [`GitHive-By: ${stamper.by}`, `GitHive-Stamp: ${await stamper.stamp(mergeStampPayload({ ...signed, by: stamper.by }))}`] : []),
		"",
	].join("\n");
}
