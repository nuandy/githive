import { FORMAT_TRAILER, RECORD_FORMAT } from "../record-format";
import { mergeStampPayload } from "./audit";
import type { Stamper } from "./stamp";

// A merge commit's message: why the change was made and who reviewed it, then the trailers the audit reads and
// GitHive's stamp over them. Every place a batch lands uses it, so all write the same thing. The intent and evidence
// are agents' own words, so they stay above the trailer block, the only part the audit reads.

/** What a merge records: the change, its agent, the records it checked, and what its checks ran on. */
export interface MergeClaim {
	/** Main before the merge, its first parent. */
	base: string;
	/** The change's commit, the merge's second parent. */
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
	/** Why the change was made, from its claim. */
	intent?: string;
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

// Agent-written text as one line, cut to `most` characters.
function oneLine(text: string, most: number) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat;
}

// Wrapped at word boundaries, so the message reads well in `git log`.
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

// The subject and body: the change's intent, and each approval's evidence.
function storyOf(claimed: MergeClaim) {
	const merged = `Merge ${claimed.change} by ${claimed.author}`;
	const intent = claimed.intent ? oneLine(claimed.intent, Number.POSITIVE_INFINITY) : "";
	// Without an intent, the subject says only who merged what.
	const lines = intent ? [oneLine(intent, SUBJECT_MOST), "", `${merged}.`] : [merged];
	if (intent.length > SUBJECT_MOST) lines.push("", ...wrapped(intent));
	const reviews = (claimed.reviews ?? []).map(
		(review) => `- ${review.reviewer} (${review.role}): ${oneLine(review.evidence, EVIDENCE_MOST)}`,
	);
	section(lines, "Reviewed by:", reviews);
	return [...lines, ""];
}

// A heading and its lines, after a blank line, when there are any.
function section(lines: string[], heading: string, items: string[]) {
	if (items.length) lines.push("", heading, ...items);
}

export async function mergeMessage(claimed: MergeClaim, stamper?: Stamper) {
	// With no votes record, write no trailer and stamp over none. The audit reads an empty trailer back as none, so a
	// stamp over "" would never verify.
	const signed = { ...claimed, votesTip: claimed.votesTip || undefined };
	const lines = [...storyOf(claimed), `GitHive-Change: ${claimed.change}`];
	if (claimed.intent) lines.push(`GitHive-Intent: ${oneLine(claimed.intent, INTENT_TRAILER_MOST)}`);
	lines.push(
		`${FORMAT_TRAILER}: ${RECORD_FORMAT}`,
		`GitHive-Agent: ${claimed.author}`,
		`GitHive-Claims: ${claimed.claimsTip}`,
	);
	if (signed.votesTip) lines.push(`GitHive-Votes: ${signed.votesTip}`);
	if (claimed.testedOn) lines.push(`GitHive-Tested: ${claimed.testedOn}`);
	// The changes checked together, in landing order. Exactly these landed on that main, in one push.
	if (claimed.testedWith?.length) lines.push(`GitHive-Tested-With: ${claimed.testedWith.join(" ")}`);
	// Who asked for the merge, as verified, and GitHive's stamp over all of the above.
	if (stamper) {
		const stamp = await stamper.stamp(mergeStampPayload({ ...signed, by: stamper.by }));
		lines.push(`GitHive-By: ${stamper.by}`, `GitHive-Stamp: ${stamp}`);
	}
	return [...lines, ""].join("\n");
}
