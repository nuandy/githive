import type { BacklogItem, HiveEvent, RepoLanding, RepoSnapshot } from "../api";
import { claimAgent, shortTitle } from "./claimStatus";
import { timeOf } from "./model";

// The Hive tab's goals: each change an agent announced, and everything that has happened to it since, put together
// from the claims, votes, the hive's event log and what's landing. A goal is the unit the tab tells a story about;
// events never get rows of their own. The event log keeps only the newest 100, so a long goal may be missing its
// first steps (`earlierSteps`); its change page has them all.

type Claim = RepoSnapshot["claims"][number];
type Vote = RepoSnapshot["votes"][number];

/** Where a goal stands. */
export type GoalState =
	"building" | "in-review" | "revising" | "approved" | "landing" | "asking" | "landed" | "released";

export type GoalStepKind =
	| "claimed"
	| "widened"
	| "pushed"
	| "approved"
	| "changes-asked"
	| "asked"
	| "merging"
	| "checking"
	| "landed"
	| "failed"
	| "released"
	| "heads-up"
	| "interface"
	| "conflicted";

export interface GoalStep {
	kind: GoalStepKind;
	at: string;
	/** Who took it: the reviewer of a vote, the agent otherwise. */
	by?: string;
	commit?: string;
	/** A vote's role. */
	role?: string;
	/** A vote's evidence, a failure's reason, a question for a person, what an awareness event is about. */
	text?: string;
	/** The other agent an awareness event names. */
	other?: string;
	/** A heads-up's side: this goal's change alters names the other's uses, or uses names the other's alters. */
	side?: "alters" | "uses";
}

export interface Goal {
	/** Unique: the change, or the change and its story's number when it was released and claimed again. */
	key: string;
	change: string;
	agent: string;
	/** A short title for the row; the intent in full is one click away. */
	title: string;
	intent: string;
	paths: string[];
	state: GoalState;
	/** When it was announced: its claim, or the earliest step known. */
	announced: string;
	/** When it landed or was dropped. */
	finished?: string;
	/** In force only. */
	head?: string | null;
	approval?: Claim["approval"];
	attention?: Claim["attention"];
	/** Oldest first. */
	steps: GoalStep[];
	/** It began before the oldest event the log keeps, so its first steps may be missing. */
	earlierSteps: boolean;
}

export interface GoalSources {
	/** The claims in force on the branch shown. */
	claims: Claim[];
	votes: Vote[];
	/** The hive's event log, newest first, as the server sends it. */
	events?: HiveEvent[];
	landing?: RepoLanding;
	/** Changes on other branches, left out (the event log is the whole repo's). */
	elsewhere?: Set<string>;
	/**
	 * The paths of claims seen earlier, by change. Nothing the server sends says what a landed change touched once its
	 * claim is gone, so the tab remembers what it saw while the claim was in force.
	 */
	remembered?: Map<string, string[]>;
}

const timeAt = (iso: string) => timeOf(iso) ?? 0;
const byTime = <T extends { at: string }>(a: T, b: T) => timeAt(a.at) - timeAt(b.at);

/** Every goal the sources show, in flight and finished, newest announced first. */
export function hiveGoals({ claims, votes, events = [], landing, elsewhere, remembered }: GoalSources): Goal[] {
	const log = [...events].sort(byTime);
	const oldest = log[0] ? timeAt(log[0].at) : undefined;
	const claimOf = new Map(claims.map((claim) => [claim.change, claim]));
	const recent = landing?.recent ?? [];

	// Which change a commit belongs to: a push names its change, a vote only its commit.
	const changeOfCommit = new Map<string, string>();
	for (const claim of claims) if (claim.head) changeOfCommit.set(claim.head, claim.change);
	for (const event of log)
		if (event.kind === "pushed" && event.commit && event.change) changeOfCommit.set(event.commit, event.change);
	for (const outcome of recent) changeOfCommit.set(outcome.head, outcome.change);
	for (const checked of landing?.checking?.changes ?? []) changeOfCommit.set(checked.head, checked.change);
	const changeOf = (commit: string | undefined) => {
		if (!commit) return undefined;
		for (const [known, change] of changeOfCommit)
			if (known.startsWith(commit) || commit.startsWith(known)) return change;
		return undefined;
	};

	// Whose a change is, even after its claim is gone: its claim, its claimed event, how it landed.
	const agentOf = new Map<string, string>();
	for (const outcome of recent) agentOf.set(outcome.change, outcome.agent);
	for (const event of log)
		if (
			event.agent &&
			event.change &&
			(event.kind === "claimed" || event.kind === "landed" || event.kind === "merging")
		)
			agentOf.set(event.change, event.agent);
	for (const claim of claims) agentOf.set(claim.change, claimAgent(claim));

	const steps = new Map<string, GoalStep[]>();
	const intents = new Map<string, string>();
	const add = (change: string | undefined, step: GoalStep) => {
		if (!change || elsewhere?.has(change)) return;
		let list = steps.get(change);
		if (!list) steps.set(change, (list = []));
		list.push(step);
	};

	for (const event of log) {
		const change = event.kind === "voted" ? (event.change ?? changeOf(event.commit)) : event.change;
		const by = event.agent ?? (change ? agentOf.get(change) : undefined);
		const step = stepOf(event, by, change, steps);
		if (event.kind === "claimed" && change && event.detail && !intents.has(change)) intents.set(change, event.detail);
		if (step) add(change, step);
		// A heads-up is one event, from the side whose change alters the names; the side using them hears it too.
		if (event.kind === "heads_up" && event.otherChange)
			add(event.otherChange, {
				kind: "heads-up",
				at: event.at,
				...(event.agent ? { by: event.agent } : {}),
				...(event.other ? { other: event.other } : {}),
				side: "uses",
				...(event.detail ? { text: event.detail } : {}),
			});
	}

	// Votes in the snapshot carry their evidence; they replace the log's word of the same vote.
	for (const vote of votes) {
		const change = changeOf(vote.commit);
		if (!change) continue;
		const list = steps.get(change) ?? [];
		const same = list.findIndex(
			(step) => isVote(step) && step.by === vote.reviewer && sameCommit(step.commit, vote.commit),
		);
		const step = voteStep(vote);
		if (same >= 0) list[same] = step;
		else add(change, step);
	}

	for (const outcome of recent) {
		const kind = outcome.how === "landed" ? "landed" : "failed";
		const text = outcome.reasons?.join("; ");
		const near = (step: GoalStep) => step.kind === kind && Math.abs(timeAt(step.at) - timeAt(outcome.at)) < 60_000;
		const told = steps.get(outcome.change)?.find(near);
		if (told) {
			// The log said so already; the landing adds the reasons.
			if (text && !told.text) told.text = text;
			continue;
		}
		add(outcome.change, {
			kind,
			at: outcome.at,
			by: outcome.agent,
			...(outcome.commit ? { commit: outcome.commit } : {}),
			...(text ? { text } : {}),
		});
	}

	const checking = landing?.checking;
	for (const checked of checking?.changes ?? []) {
		const claim = claimOf.get(checked.change);
		if (claim && claim.head === checked.head)
			add(checked.change, { kind: "checking", at: checking!.since, by: checked.agent });
	}

	for (const claim of claims) {
		const list = steps.get(claim.change) ?? [];
		// The claim's own announcement, unless the log has it (a claim's first event is at its `since`).
		const announced = list.some((step) => step.kind === "claimed" && timeAt(step.at) >= timeAt(claim.since) - 5_000);
		if (!announced) add(claim.change, { kind: "claimed", at: claim.since, by: claimAgent(claim), text: claim.intent });
		const attention = claim.attention;
		if (attention && !list.some((step) => step.kind === "asked" && step.at === attention.at))
			add(claim.change, { kind: "asked", at: attention.at, by: attention.agent, text: attention.reason });
	}

	const goals: Goal[] = [];
	for (const [change, list] of steps) {
		list.sort((a, b) => byTime(a, b) || STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind));
		const claim = claimOf.get(change);
		const stories = storiesOf(list);
		for (const [index, story] of stories.entries()) {
			const last = index === stories.length - 1;
			const held = last ? claim : undefined;
			const ending = held ? undefined : endingOf(story);
			// A story whose claim is gone without a landing or a release we know of: on another branch, or its end fell
			// out of the log. Either way it's no story to tell here.
			if (!held && !ending) continue;
			const start = story.find((step) => step.kind === "claimed");
			const intent = held?.intent ?? start?.text ?? (last ? intents.get(change) : undefined) ?? "";
			const announced = held?.since ?? start?.at ?? story[0]!.at;
			goals.push({
				// A change released and claimed again by someone else is two stories; the one in force keeps the name.
				key: last ? change : `${change}#${index + 1}`,
				change,
				agent: held ? claimAgent(held) : (start?.by ?? agentOf.get(change) ?? "an agent"),
				title: shortTitle(intent) || change,
				intent,
				paths: held?.paths ?? (last ? remembered?.get(change) : undefined) ?? [],
				state: held ? stateOf(held, votes, landing) : ending!.kind,
				announced,
				...(ending ? { finished: ending.at } : {}),
				...(held ? { head: held.head, approval: held.approval } : {}),
				...(held?.attention ? { attention: held.attention } : {}),
				steps: story,
				earlierSteps: oldest === undefined || oldest > timeAt(announced),
			});
		}
	}
	return goals.sort((a, b) => timeAt(b.announced) - timeAt(a.announced) || a.key.localeCompare(b.key));
}

/** A change's steps split into stories: each claim after the first (made after a release) starts another. */
function storiesOf(steps: GoalStep[]): GoalStep[][] {
	const stories: GoalStep[][] = [];
	for (const step of steps) {
		const current = stories[stories.length - 1];
		if (!current || (step.kind === "claimed" && current.some((each) => each.kind === "claimed"))) stories.push([step]);
		else current.push(step);
	}
	return stories;
}

/** Steps that happen together, in the order they're told. */
const STEP_ORDER: GoalStepKind[] = [
	"claimed",
	"widened",
	"pushed",
	"changes-asked",
	"approved",
	"asked",
	"merging",
	"checking",
	"failed",
	"landed",
	"released",
	"heads-up",
	"interface",
	"conflicted",
];

const isVote = (step: GoalStep) => step.kind === "approved" || step.kind === "changes-asked";
const sameCommit = (a: string | undefined, b: string) => !!a && (a.startsWith(b) || b.startsWith(a));

function voteStep(vote: Vote): GoalStep {
	const evidence = (vote.evidence ?? "").trim().split("\n")[0] ?? "";
	return {
		kind: vote.verdict === "approve" ? "approved" : "changes-asked",
		at: vote.at,
		by: vote.reviewer,
		commit: vote.commit,
		role: vote.role,
		...(evidence ? { text: evidence.length > 240 ? `${evidence.slice(0, 239)}…` : evidence } : {}),
	};
}

/** An event as a step of its change's goal, if it is one. */
function stepOf(
	event: HiveEvent,
	by: string | undefined,
	change: string | undefined,
	steps: Map<string, GoalStep[]>,
): GoalStep | undefined {
	const base = { at: event.at, ...(by ? { by } : {}), ...(event.commit ? { commit: event.commit } : {}) };
	const text = event.detail ? { text: event.detail } : {};
	switch (event.kind) {
		case "claimed": {
			// Another claim on a change in force widens it; one after a release (someone taking it up again, perhaps
			// another agent) is a new announcement.
			const story = change
				? (steps.get(change) ?? []).filter((step) => step.kind === "claimed" || step.kind === "released")
				: [];
			const widens = story[story.length - 1]?.kind === "claimed";
			return widens ? { kind: "widened", ...base } : { kind: "claimed", ...base, ...text };
		}
		case "pushed":
			return { kind: "pushed", ...base };
		case "voted":
			return {
				kind: event.verdict === "reject" ? "changes-asked" : "approved",
				...base,
				...(event.agent ? { by: event.agent } : {}),
				...(event.detail ? { role: event.detail } : {}),
			};
		case "merging":
			return { kind: "merging", ...base };
		case "landed":
			return { kind: "landed", ...base };
		case "failed":
			return { kind: "failed", ...base, ...text };
		case "asked":
			return { kind: "asked", ...base, ...text };
		case "released":
			return { kind: "released", ...base, ...text };
		case "heads_up":
			return { kind: "heads-up", ...base, ...text, ...(event.other ? { other: event.other } : {}), side: "alters" };
		case "interface":
			return { kind: "interface", ...base, ...text, ...(event.other ? { other: event.other } : {}) };
		case "conflicted":
			return { kind: "conflicted", ...base, ...text };
		default:
			// reverted, added, building: not a step of a goal.
			return undefined;
	}
}

/** How a goal whose claim is gone ended: its last landing or release. */
function endingOf(steps: GoalStep[]): { kind: "landed" | "released"; at: string } | undefined {
	for (let index = steps.length - 1; index >= 0; index--) {
		const step = steps[index]!;
		if (step.kind === "landed" || step.kind === "released") return { kind: step.kind, at: step.at };
	}
	return undefined;
}

/** Where a goal in force stands, from its claim, the votes on its head and the batch being checked. */
function stateOf(claim: Claim, votes: Vote[], landing: RepoLanding | undefined): GoalState {
	if (claim.attention) return "asking";
	if (!claim.head) return "building";
	const checking = landing?.checking?.changes.some(
		(checked) => checked.change === claim.change && checked.head === claim.head,
	);
	if (checking) return "landing";
	// Before approval: a batch that failed leaves the change approved ("checks" blocks nothing) and its head rejected.
	const onHead = votes.filter((vote) => vote.commit === claim.head && vote.reviewer !== claim.agent);
	if (onHead.some((vote) => vote.verdict === "reject") || claim.approval.vetoedBy.length) return "revising";
	if (claim.approval.approved) return "approved";
	return "in-review";
}

/** How many approvals a goal has asked for and been refused, for "after 1 rejection". */
export const rejections = (goal: Goal) => goal.steps.filter((step) => step.kind === "changes-asked").length;

/** Where a goal stands, in a few words, with the tone it's drawn in. */
export function goalStatus(goal: Goal): { words: string; tone: "accent" | "amber" | "good" | "bad" | "muted" } {
	const rejected = rejections(goal);
	const after = rejected ? ` · after ${rejected === 1 ? "1 rejection" : `${rejected} rejections`}` : "";
	const approval = goal.approval;
	switch (goal.state) {
		case "building":
			return { words: "building", tone: "accent" };
		case "revising": {
			const last = [...goal.steps].reverse().find((step) => step.kind === "changes-asked" || step.kind === "failed");
			const checks = last?.kind === "failed" || last?.role === "checks";
			return { words: checks ? "checks failed, fixing" : "changes asked, revising", tone: "bad" };
		}
		case "in-review": {
			const awaiting = approval?.awaiting ?? [];
			if (approval && approval.approvals >= approval.required && awaiting.length)
				return { words: `waiting for a ${awaiting.join(" and ")} vote`, tone: "bad" };
			return { words: `in review · ${approval?.approvals ?? 0} of ${approval?.required ?? 1}${after}`, tone: "accent" };
		}
		case "asking":
			return { words: `asking a person: ${goal.attention?.reason ?? "a question"}`, tone: "bad" };
		case "approved":
			return { words: `approved, landing with the next batch${after}`, tone: "good" };
		case "landing":
			return { words: `landing${after}`, tone: "amber" };
		case "landed":
			return { words: `landed${after}`, tone: "good" };
		case "released":
			return { words: "dropped", tone: "muted" };
	}
}

/** Backlog items free to take: not claimed, not landed, and everything they wait for has merged. */
export function freeWork(backlog: BacklogItem[], goals: Goal[]): BacklogItem[] {
	const taken = new Set(goals.filter((goal) => goal.state !== "released").map((goal) => goal.change));
	const listed = new Set(backlog.map((item) => item.id));
	const landed = new Set(goals.filter((goal) => goal.state === "landed").map((goal) => goal.change));
	const merged = (id: string) => landed.has(id) || !listed.has(id);
	return backlog.filter((item) => !taken.has(item.id) && (item.after ?? []).every(merged));
}

/** The stages the strip counts. */
export type Stage = "next" | "building" | "review" | "landing" | "landed";

export const STAGE_OF: Record<GoalState, Stage | undefined> = {
	building: "building",
	revising: "building",
	"in-review": "review",
	asking: "review",
	approved: "landing",
	landing: "landing",
	landed: "landed",
	released: undefined,
};

/** How many goals are at each stage; landed ones only since `since`. */
export function stageCounts(goals: Goal[], upNext: number, since: number): Record<Stage, number> {
	const counts: Record<Stage, number> = { next: upNext, building: 0, review: 0, landing: 0, landed: 0 };
	for (const goal of goals) {
		const stage = STAGE_OF[goal.state];
		if (!stage) continue;
		if (stage === "landed" && timeAt(goal.finished ?? goal.announced) < since) continue;
		counts[stage]++;
	}
	return counts;
}
