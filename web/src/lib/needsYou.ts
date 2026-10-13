import type { RepoAudit, RepoSnapshot } from "../api";
import { type Waiting, waitingOn } from "./status";

// What in a repo needs a person, decided once (status.ts, waitingOn), for the Hive's banner and the Changes tab:
// agents' questions, votes only people may give, and the audit's open violations. Failed checks aren't in it: they're
// the agent's own work. The Inbox and the Repositories list count the same from the server's summaries (repos.ts).

export interface NeedsYou {
	/** The changes waiting on a person: questions first, then votes. */
	changes: Waiting[];
	/** The audit's open violations. */
	violations: number;
	/** All of it, as the Inbox counts it. */
	count: number;
}

export function needsYou(
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "policy" | "branchRules" | "branch">,
	audit?: Pick<RepoAudit, "open">,
): NeedsYou {
	const { votes } = snapshot;
	// Each change is held to its own branch's policy (status.ts, claimPolicy).
	const waiting = snapshot.claims.flatMap((claim) => waitingOn(claim, { votes, settings: snapshot }) ?? []);
	const changes = [
		...waiting.filter((each) => each.kind === "question"),
		...waiting.filter((each) => each.kind === "vote"),
	];
	const violations = audit?.open ?? 0;
	return { changes, violations, count: changes.length + violations };
}
