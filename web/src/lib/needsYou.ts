import type { RepoAudit, RepoSnapshot } from "../api";
import { timeOf } from "./model";
import { steeringOn, type Waiting, waitingOn } from "./status";

// What in a repo needs a person, decided once (status.ts, waitingOn and steeringOn), for the Hive's banner and the
// Changes tab: agents' questions, text Clef flags as steering agents, votes only people may give, and the audit's open
// violations. Failed checks aren't in it: they're the agent's own work. The Inbox and the Repositories list count the
// same from the server's summaries (repos.ts).

export interface NeedsYou {
	/** The changes waiting on a person, in the order they show (see byWaiting). */
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
	const waiting = snapshot.claims.flatMap((claim) => personWaitedOn(claim, { votes, settings: snapshot }) ?? []);
	// A vote waits since its change was last active, as the server's summaries say.
	const active = new Map(snapshot.claims.map((claim) => [claim.change, claim.active]));
	const order = (each: Waiting) => (each.kind === "question" ? each : { kind: each.kind, at: active.get(each.change) });
	const changes = waiting.sort((a, b) => byWaiting(order(a), order(b)));
	const violations = audit?.open ?? 0;
	return { changes, violations, count: changes.length + violations };
}

type Claim = RepoSnapshot["claims"][number];

/**
 * What a change needs a person for, one thing a change, as the server's summaries count it (dashboard.ts,
 * waitingOnPerson): its agent's question, then Clef's flag, then a vote only people may give.
 */
function personWaitedOn(claim: Claim, context: Parameters<typeof waitingOn>[1]): Waiting | undefined {
	const waiting = waitingOn(claim, context);
	if (waiting?.kind === "question") return waiting;
	return steeringOn(claim) ?? waiting;
}

/** Questions first, then Clef's flags, then votes. */
const KIND_RANK: Record<string, number> = { question: 0, steering: 1, vote: 2 };

/** What a thing waiting on a person is ordered by. */
export interface WaitingOrder {
	kind: string;
	urgency?: number | undefined;
	/** Since when it waits. */
	at?: string | undefined;
}

/**
 * The order what waits on a person shows in, the same in the Hive's banner and the Inbox: agents' questions, then
 * Clef's flags, then votes only people may give; each most urgent first (as Clef rates a question), then waiting
 * longest first.
 */
export function byWaiting(a: WaitingOrder, b: WaitingOrder): number {
	const rank = (each: WaitingOrder) => KIND_RANK[each.kind] ?? 2;
	const kind = rank(a) - rank(b);
	const urgency = (b.urgency ?? 0) - (a.urgency ?? 0);
	const since = (each: WaitingOrder) => timeOf(each.at) ?? Number.MAX_SAFE_INTEGER;
	return kind || urgency || since(a) - since(b);
}
