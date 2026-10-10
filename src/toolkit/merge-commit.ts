import { FORMAT_TRAILER, RECORD_FORMAT } from "../record-format";
import { mergeStampPayload } from "./audit";
import type { Stamper } from "./stamp";

// A merge commit's message: the trailers the audit reads, and GitHive's stamp
// over them. Made wherever a batch lands (the repo's Gate, or in memory), so
// both write exactly the same thing.

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
}

export async function mergeMessage(claimed: MergeClaim, stamper?: Stamper) {
	// No votes record at all (no review asked for, none cast): no trailer, and the stamp over none, as the audit reads it.
	// An empty trailer reads back as none, so a stamp over "" never verified: 200 merges without review all unverified.
	const signed = { ...claimed, votesTip: claimed.votesTip || undefined };
	return [
		`Merge ${claimed.change} by ${claimed.author}`,
		"",
		`GitHive-Change: ${claimed.change}`,
		`${FORMAT_TRAILER}: ${RECORD_FORMAT}`,
		`GitHive-Agent: ${claimed.author}`,
		`GitHive-Claims: ${claimed.claimsTip}`,
		...(signed.votesTip ? [`GitHive-Votes: ${signed.votesTip}`] : []),
		// Which main the checks passed on.
		...(claimed.testedOn ? [`GitHive-Tested: ${claimed.testedOn}`] : []),
		// The changes checked together on it, in landing order: exactly these landed on it, in one push.
		...(claimed.testedWith?.length ? [`GitHive-Tested-With: ${claimed.testedWith.join(" ")}`] : []),
		// Who asked for it, as Access verified them, and GitHive's stamp over all of the above.
		...(stamper
			? [
					`GitHive-By: ${stamper.by}`,
					`GitHive-Stamp: ${await stamper.stamp(mergeStampPayload({ ...signed, by: stamper.by }))}`,
				]
			: []),
		"",
	].join("\n");
}
