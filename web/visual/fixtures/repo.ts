import type {
	BranchHistory,
	ChangeHistory,
	HiveEvent,
	HiveStatus,
	LandingStretch,
	RepoAudit,
	RepoLanding,
	RepoSnapshot,
} from "../../src/api.ts";
import type { Level } from "../../src/lib/permissions.ts";
import type { RepoSummary, WaitingItem } from "../../src/lib/repos.ts";
import { ago } from "./clock.ts";
import type { Hive } from "./stories.ts";

// One repo as the fixtures hold it: everything any of its routes answers.

export interface RepoFixture {
	fullName: string;
	id: string;
	visibility: "private" | "public";
	createdAt: string;
	/** The signed-in admin's permission here. */
	level: Level;
	/** Someone else's public repo: listed apart in the Repositories list. */
	others?: boolean;
	/** Its default branch, or null for a repo with no commits. */
	branch: string | null;
	/** Branch heads by name. A tree or file at any of them, or at any commit id, reads `files`. */
	heads: Record<string, string>;
	/** Every file on its default branch, sorted. */
	files: string[];
	/** File texts that are this repo's own (its README); others are made up from their paths. */
	texts?: Record<string, string>;
	/** Null until GitHive starts on it. */
	hive: null | {
		snapshot: RepoSnapshot;
		audit: RepoAudit;
		events: HiveEvent[];
		/** What's landing, by branch. */
		landings: Record<string, RepoLanding>;
		/** What landed, by branch. */
		histories: Record<string, BranchHistory>;
		changes: Map<string, ChangeHistory>;
	};
	/** GitHive's hosted agents on it, null when it never had any. */
	hosted: HiveStatus | null;
	collaborators: { handle: string; permission: Level }[];
	/** Its counts for the Repositories list and the Inbox, null before GitHive counted it. */
	summary: RepoSummary | null;
}

/** What the server keeps for the Repositories list and the Inbox, from what the repo's routes answer. */
export function summaryOf(
	snapshot: RepoSnapshot,
	audit: RepoAudit,
	lastActivity: string | undefined,
	lastStretch: LandingStretch | undefined,
): RepoSummary {
	const waiting = snapshot.claims.flatMap((claim) => waitingItem(snapshot, claim) ?? []);
	return {
		open: snapshot.claims.length,
		needsYou: waiting.length,
		merged: audit.merges,
		violations: audit.open,
		...(lastActivity ? { lastActivity } : {}),
		...(lastStretch ? { lastStretch } : {}),
		countedAt: ago(1),
		waiting,
	};
}

/**
 * What a claim waits on a person for, as the server's summary says it: its agent's question, or, pushed and not sent
 * back, a vote only people may give (the server's waitingOnPerson; the dashboard's status.ts, waitingOn).
 */
function waitingItem(snapshot: RepoSnapshot, claim: RepoSnapshot["claims"][number]): WaitingItem | null {
	const { change, attention, approval, head } = claim;
	const title = (claim.intent.split("\n")[0] ?? "").slice(0, 120);
	if (attention)
		return {
			kind: "question",
			change,
			title,
			reason: attention.reason.slice(0, 500),
			agent: attention.agent,
			at: attention.at,
			...(attention.urgency === undefined ? {} : { urgency: attention.urgency }),
		};
	if (!head || approval.approved || approval.vetoedBy.length) return null;
	const sentBack = snapshot.votes.some(
		(vote) => vote.commit === head && vote.verdict === "reject" && vote.reviewer !== claim.agent,
	);
	if (sentBack) return null;
	const people = (holder: string) => holder === "person:*" || /^person:[^/]+$/.test(holder) || holder.startsWith("@");
	const peopleOnly = (role: string) => (snapshot.policy.grants?.[role] ?? ["githive"]).every(people);
	const role = (approval.awaiting ?? []).find(peopleOnly);
	if (!role) return null;
	return {
		kind: "vote",
		change,
		title,
		role,
		reason: `Waiting for a ${role} vote, which only a person can give.`,
		agent: claim.agent,
		at: claim.active,
	};
}

/** A branch's landing view from a hive. */
export function landingOf(hive: Hive, branch: string, stretch?: LandingStretch): RepoLanding {
	return { branch, ...(stretch ? { stretch } : {}), checking: hive.checking, recent: hive.recent };
}
