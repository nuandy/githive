// What a failed claim leaves behind, given back by GitHive rather than left to the agent: records a refused claim
// couldn't undo, and a claim written although the call failed. Only ever the calling agent's own.
import type { ClaimOutcome } from "../claim-store";
import type { ToolCall } from "./context";

/**
 * A refused claim whose records in some shards couldn't be undone holds those paths in the agent's name: GitHive
 * releases them itself rather than leave it to the agent. If that fails too, the reply still says to.
 */
export async function withoutLeftovers(
	outcome: ClaimOutcome,
	renewing: boolean,
	giveBack: (reason: string) => Promise<boolean>,
): Promise<ClaimOutcome> {
	if (outcome.ok) return outcome;
	if (!outcome.stillHeld?.length) return outcome;
	if (renewing) return outcome;
	if (!(await giveBack("its refused claim left records behind"))) return outcome;
	const { stillHeld: _, ...cleared } = outcome;
	return cleared;
}

/**
 * Releases what's left of a claim that failed; whether it did. Only the agent's own: a change name another agent
 * holds (a refusal for that) is left alone. Nothing held is nothing to give back.
 */
export async function giveBackPartClaim(
	call: ToolCall,
	claimStore: ToolCall["store"],
	claim: { change: string; agent: string; reason: string },
) {
	const records = await claimStore.claimRecords(claim.change).catch(() => []);
	if (!records.length) return false;
	if (records.some((record) => record.agent !== claim.agent)) return false;
	const released = await claimStore.release(claim, call.stamper).catch((err) => {
		console.error(`giving back ${claim.change}'s claim failed`, String(err));
		return { ok: false };
	});
	return released.ok;
}
