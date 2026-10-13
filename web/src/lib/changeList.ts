import type { RepoSnapshot } from "../api";
import { claimAgent, claimTitle } from "./claimStatus";
import { shortAge } from "./relativeTime";
import { changeState, type ClaimState, type StateContext, type Waiting, waitingOn } from "./status";

// The Changes tab's list: a branch's open changes, what needs action first, narrowed by a filter (in the address) and
// a search. A change's state and what it waits on a person for come from status.ts, as everywhere.

type Claim = RepoSnapshot["claims"][number];

/** The list's filters, as the address names them (?filter=needs-you), in the order their chips show. */
export const CHANGE_FILTERS = ["needs-you", "in-review", "approved", "building", "landing", "all"] as const;
export type ChangeFilter = (typeof CHANGE_FILTERS)[number];

/** Each filter's chip. */
export const FILTER_WORDS: Record<ChangeFilter, string> = {
	"needs-you": "Needs you",
	"in-review": "In review",
	approved: "Approved",
	building: "Building",
	landing: "Landing",
	all: "All",
};

/** The filter an address asks for; anything else is all of them. */
export function parseFilter(raw: string | null | undefined): ChangeFilter {
	return (CHANGE_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as ChangeFilter) : "all";
}

/** The open changes landing on `branch` (a change lands on its `into`, else the project's branch). */
export function openOn(snapshot: Pick<RepoSnapshot, "claims" | "branch">, branch: string): Claim[] {
	const project = snapshot.branch ?? "main";
	return snapshot.claims.filter((claim) => (claim.into ?? project) === branch);
}

/** A change as the list shows it: its state, and what it waits on a person for, if anything. */
export interface ListedChange {
	claim: Claim;
	state: ClaimState;
	waiting?: Waiting;
}

function listed(claim: Claim, context: StateContext): ListedChange {
	const waiting = waitingOn(claim, context);
	return { claim, state: changeState(claim, context), ...(waiting ? { waiting } : {}) };
}

function inFilter(change: ListedChange, filter: ChangeFilter): boolean {
	if (filter === "all") return true;
	if (filter === "needs-you") return !!change.waiting;
	return change.state === filter;
}

/**
 * How soon a change wants someone, soonest first: a person (an agent's question, a vote only people give), then what
 * went back to its agent (sent back, checks failed), then what's approved and landing, in review, being built, and
 * last what its agent left.
 */
function actionRank({ state, waiting }: ListedChange): number {
	if (waiting || state === "needs-person") return 0;
	switch (state) {
		case "changes-requested":
		case "checks-failed":
			return 1;
		case "approved":
			return 2;
		case "landing":
			return 3;
		case "in-review":
			return 4;
		case "building":
			return 5;
		default:
			return 6;
	}
}

const byAction = (a: ListedChange, b: ListedChange) =>
	actionRank(a) - actionRank(b) ||
	Date.parse(b.claim.active) - Date.parse(a.claim.active) ||
	a.claim.change.localeCompare(b.claim.change);

/** Whether a change matches a search: every word somewhere in its title, id, agent or paths, in any case. */
export function matchesQuery(claim: Claim, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const text = [claimTitle(claim), claim.change, claimAgent(claim), ...claim.paths].join("\n").toLowerCase();
	return words.every((word) => text.includes(word));
}

/**
 * The changes to show, what needs action first and then the one active last, and how many each filter would show
 * with the search as it is.
 */
export function changeList(
	claims: Claim[],
	context: StateContext,
	{ filter, query }: { filter: ChangeFilter; query: string },
): { shown: ListedChange[]; counts: Record<ChangeFilter, number> } {
	const found = claims.filter((claim) => matchesQuery(claim, query)).map((claim) => listed(claim, context));
	const counts = Object.fromEntries(
		CHANGE_FILTERS.map((each) => [each, found.filter((change) => inFilter(change, each)).length]),
	) as Record<ChangeFilter, number>;
	return { shown: found.filter((change) => inFilter(change, filter)).sort(byAction), counts };
}

/** When a change was last active, for the right of its row: "active 4m ago". */
export function activeWords(active: string, now: number = Date.now()): string {
	const age = shortAge(active, now);
	if (!age) return "";
	if (age === "now") return "active now";
	return /^\d+[mhd]$/.test(age) ? `active ${age} ago` : `active ${age}`;
}

/** What a screen reader hears as changes open while the list shows: "New change on main: …, by …". */
export function arrivalWords(arrived: Claim[], branch: string): string {
	if (!arrived.length) return "";
	if (arrived.length === 1) {
		const [one] = arrived;
		return `New change on ${branch}: ${claimTitle(one!)}, by ${claimAgent(one!)}.`;
	}
	const titles = arrived.map(claimTitle);
	return `${arrived.length} new changes on ${branch}: ${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}.`;
}
