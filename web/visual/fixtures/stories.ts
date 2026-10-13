import type {
	BranchRule,
	ChangeAwareness,
	ChangeHistory,
	HiveEvent,
	LandedChange,
	MergeCheck,
	RepoLanding,
	RepoSnapshot,
} from "../../src/api.ts";
import { leaseFor } from "../../../src/toolkit/staleness.ts";
import { ago } from "./clock.ts";
import { sha } from "./ids.ts";
import { ownerOf } from "./people.ts";

// A repo's hive, told as one story per change: what happened to it and when. Everything the server would answer
// about those changes (claims, votes, the event log, the landing, each change's page, the branch's history) is worked
// out from the stories, so the answers agree with one another the way the server's do.

type Claim = RepoSnapshot["claims"][number];
type Vote = RepoSnapshot["votes"][number];
type Policy = RepoSnapshot["policy"];
type Outcome = RepoLanding["recent"][number];

/** One thing that happened to a change, `at` minutes before FIXED_NOW. */
export type Step =
	| { kind: "push"; at: number; message: string }
	| { kind: "vote"; at: number; reviewer: string; role: string; verdict: "approve" | "reject"; evidence: string }
	/** Its agent claimed it again: renewing the claim, and widening it by `paths`. */
	| { kind: "reclaim"; at: number; paths?: string[] }
	| { kind: "merging"; at: number }
	/** Its checks failed while landing: put out of the batch, its head rejected by githive-checks. */
	| { kind: "failed"; at: number; reason: string; output?: string }
	| { kind: "asked"; at: number; reason: string }
	| { kind: "conflicted"; at: number; files: string[] }
	| { kind: "landed"; at: number }
	| { kind: "released"; at: number; reason: string; stale?: boolean };

export interface Story {
	change: string;
	agent: string;
	intent: string;
	paths: string[];
	/** Minutes ago it was claimed. */
	claimed: number;
	/** Minutes ago its agent last claimed it: by default its last reclaim, else when it was claimed. */
	active?: number;
	into?: string;
	after?: string[];
	steps: Step[];
	/** In the batch being checked to land now. */
	checking?: boolean;
	/** A question for a person: an agent's, GitHive's flag, or a failed builder's. */
	attention?: { reason: string; agent: string; at: number };
	hosted?: Claim["hosted"];
	/** The files its merge touched, when they aren't its claimed paths. */
	files?: string[];
	/** How many files its merge touched, when that's more than `files` lists (the server lists 20). */
	filesTotal?: number;
	/** Its agent's last merge check, when it isn't a clean one against the branch's head. */
	merge?: (head: string, branchHead: string) => MergeCheck;
	/** Where its code meets other open changes. */
	awareness?: (head: string) => ChangeAwareness;
}

export interface HiveInput {
	repo: string;
	branch: string;
	policy: Policy;
	branchRules?: BranchRule[];
	/** The project branch's head before any story landed. */
	baseHead: string;
	/** Other branches' heads. */
	otherHeads?: Record<string, string>;
	stories: Story[];
	/** Events that are no one story's steps: awareness, work added, builders asked for. */
	extraEvents?: { at: number; event: Omit<HiveEvent, "at"> }[];
	/** How far back the event log and the landing's recent outcomes reach, in minutes. */
	logReach?: number;
	/** When the batch being checked started, in minutes ago. */
	checkingSince?: number;
	/** Every file on the branch, to turn claimed folders into the files a merge touched. */
	files: string[];
}

export interface Hive {
	/** The project branch's head: the newest landing's merge, else the base. */
	head: string;
	claims: Claim[];
	/** Every vote, oldest first. */
	votes: Vote[];
	/** The event log, newest first, as the server sends it. */
	events: HiveEvent[];
	checking: RepoLanding["checking"];
	/** Settled lately, newest last. */
	recent: Outcome[];
	changes: Map<string, ChangeHistory>;
	/** Landed on the project branch, newest first. */
	landed: LandedChange[];
	/** The newest event's time. */
	lastActivity: string | undefined;
}

/** The merge commit a story's change landed as. */
export const mergeCommit = (repo: string, change: string): string => sha(`${repo}:${change}:merge`);

/**
 * A change that landed long ago, before the event log reaches: claimed, pushed once, reviewed (or not, while the repo
 * needed no reviews) and landed `landed` minutes ago.
 */
export function landedLongAgo(
	change: string,
	agent: string,
	intent: string,
	paths: string[],
	landed: number,
	reviews: [reviewer: string, role: string, evidence: string][],
	extra: Partial<Story> = {},
): Story {
	return {
		change,
		agent,
		intent,
		paths,
		claimed: landed + 150,
		steps: [
			{ kind: "push", at: landed + 70, message: (intent.split("\n")[0] ?? "").trim() },
			...reviews.map(([reviewer, role, evidence], index) => ({
				kind: "vote" as const,
				at: landed + 40 - index * 9,
				reviewer,
				role,
				verdict: "approve" as const,
				evidence,
			})),
			{ kind: "merging", at: landed + 4 },
			{ kind: "landed", at: landed },
		],
		...extra,
	};
}

/** How many events the server's log keeps. */
const EVENTS_KEPT = 100;

const firstLine = (text: string) => (text.split("\n")[0] ?? "").trim();
const clean = (path: string) => path.replace(/\/+$/, "");

/** Whether a claimed path covers `path`: the same path, or a folder holding it. */
function covers(claimed: string, path: string) {
	const claim = clean(claimed);
	const target = clean(path);
	return target === claim || target.startsWith(`${claim}/`);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const globMatch = (pattern: string, name: string) =>
	new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`).test(name);

/** The policy a change merges under: its branch's rule over the repo's, and stricter for the paths it claims. */
function policyFor(input: HiveInput, story: Story): { required: number; vetoes: string[] } {
	let policy: Policy = input.policy;
	const rule = story.into ? input.branchRules?.find((each) => globMatch(each.pattern, story.into!)) : undefined;
	if (rule?.policy) policy = { ...policy, ...rule.policy };
	let required = policy.required;
	const vetoes = new Set(policy.vetoes);
	for (const stricter of policy.escalate ?? []) {
		const touched = stricter.paths.some((rulePath) => story.paths.some((path) => covers(rulePath, path)));
		if (!touched) continue;
		required = Math.max(required, stricter.required ?? required);
		for (const role of stricter.vetoes ?? []) vetoes.add(role);
	}
	return { required, vetoes: [...vetoes] };
}

/** A change's approval on its head: each reviewer's latest vote, the author's and the checks' left out. */
function approvalOf(
	story: Story,
	head: string | null,
	votes: Vote[],
	policy: { required: number; vetoes: string[] },
): Claim["approval"] {
	const { required, vetoes } = policy;
	if (!head) return { approved: false, approvals: 0, required, vetoedBy: [], awaiting: vetoes };
	const latest = new Map<string, Vote>();
	for (const vote of votes)
		if (vote.commit === head && vote.reviewer !== story.agent && vote.role !== "checks")
			latest.set(vote.reviewer, vote);
	const counted = [...latest.values()];
	const approvals = counted.filter((vote) => vote.verdict === "approve").length;
	// As the server's approval() has them (src/toolkit/votes.ts): who blocked it, by their names, and the roles no one
	// has approved as yet, a blocked one among them.
	const vetoedBy = counted
		.filter((vote) => vote.verdict === "reject" && vetoes.includes(vote.role))
		.map((vote) => vote.reviewer);
	const awaiting = vetoes.filter((role) => !counted.some((vote) => vote.role === role && vote.verdict === "approve"));
	const approved = approvals >= required && !vetoedBy.length && !awaiting.length;
	return { approved, approvals, required, vetoedBy, awaiting };
}

/** The files a merge of `paths` touched: claimed folders as the files in them. */
function touched(paths: string[], files: string[]): string[] {
	return paths.flatMap((path) => {
		if (files.includes(clean(path))) return [clean(path)];
		const inside = files.filter((file) => file.startsWith(`${clean(path)}/`));
		return inside.length ? inside : [clean(path)];
	});
}

interface Push {
	commit: string;
	at: number;
	message: string;
}

type Ending = Extract<Step, { kind: "landed" | "released" }>;

export function buildHive(input: HiveInput): Hive {
	const { repo, stories } = input;
	const reach = input.logReach ?? Infinity;

	// Each change's pushes, oldest first.
	const pushesOf = new Map<string, Push[]>();
	for (const story of stories) {
		const pushes = story.steps.flatMap((step, index) =>
			step.kind === "push"
				? [{ commit: sha(`${repo}:${story.change}:${index}`), at: step.at, message: step.message }]
				: [],
		);
		pushesOf.set(
			story.change,
			pushes.sort((a, b) => b.at - a.at),
		);
	}
	/** The change's head at a time: its newest push by then. */
	const headAt = (story: Story, at: number): string | null => {
		let head: string | null = null;
		for (const push of pushesOf.get(story.change) ?? []) if (push.at >= at) head = push.commit;
		return head;
	};
	const mustHead = (story: Story, at: number): string => {
		const head = headAt(story, at);
		if (!head) throw new Error(`${story.change} has nothing pushed ${at} minutes ago`);
		return head;
	};
	const endingOf = (story: Story) =>
		story.steps.find((step): step is Ending => step.kind === "landed" || step.kind === "released");
	const mergeOf = (story: Story) => mergeCommit(repo, story.change);
	const landedAt = (story: Story) => {
		const ending = endingOf(story);
		return ending?.kind === "landed" ? ending.at : undefined;
	};

	// The project branch's head: the newest landing onto it.
	const onProject = stories.filter((story) => !story.into && landedAt(story) !== undefined);
	onProject.sort((a, b) => landedAt(a)! - landedAt(b)!);
	const head = onProject[0] ? mergeOf(onProject[0]) : input.baseHead;

	// Votes, with the checks' rejection of a head put out of its batch.
	const timed: { at: number; vote: Vote }[] = [];
	for (const story of stories)
		for (const step of story.steps) {
			if (step.kind === "vote") {
				// A person's agent votes as them and itself, as GitHive stamps it: person:<hash>/<agent>.
				const owner = ownerOf(step.reviewer);
				const by = owner ? `${owner}/${step.reviewer.split("/")[1]}` : undefined;
				const vote: Vote = {
					commit: mustHead(story, step.at),
					reviewer: step.reviewer,
					role: step.role,
					verdict: step.verdict,
					evidence: step.evidence,
					at: ago(step.at),
					...(by ? { by } : {}),
				};
				timed.push({ at: step.at, vote });
			} else if (step.kind === "failed") {
				const commit = mustHead(story, step.at);
				const said = `${step.reason} on ${commit.slice(0, 8)}, checked alone after its batch failed`;
				timed.push({
					at: step.at,
					vote: {
						commit,
						reviewer: "githive-checks",
						role: "checks",
						verdict: "reject",
						evidence: step.output ? `${said}:\n${step.output}` : said,
						at: ago(step.at),
					},
				});
			}
		}
	timed.sort((a, b) => b.at - a.at);
	const votes = timed.map((each) => each.vote);

	// The event log.
	const logged: { at: number; event: HiveEvent }[] = [];
	const log = (at: number, event: Omit<HiveEvent, "at">) => logged.push({ at, event: { ...event, at: ago(at) } });
	for (const story of stories) {
		const { change, agent } = story;
		log(story.claimed, { kind: "claimed", agent, change, detail: story.intent });
		for (const step of story.steps) {
			if (step.kind === "push") log(step.at, { kind: "pushed", change, commit: mustHead(story, step.at) });
			else if (step.kind === "vote")
				log(step.at, {
					kind: "voted",
					agent: step.reviewer,
					commit: mustHead(story, step.at),
					verdict: step.verdict,
					detail: step.role,
				});
			else if (step.kind === "reclaim") log(step.at, { kind: "claimed", agent, change, detail: story.intent });
			else if (step.kind === "merging") log(step.at, { kind: "merging", agent, change });
			else if (step.kind === "failed")
				log(step.at, { kind: "failed", agent, change, commit: mustHead(story, step.at), detail: step.reason });
			else if (step.kind === "asked") log(step.at, { kind: "asked", agent, change, detail: step.reason });
			else if (step.kind === "conflicted")
				log(step.at, {
					kind: "conflicted",
					agent,
					change,
					commit: mustHead(story, step.at),
					detail: step.files.join(", "),
				});
			else if (step.kind === "landed") log(step.at, { kind: "landed", agent, change, commit: mergeOf(story) });
			else log(step.at, { kind: "released", agent, change, detail: step.reason });
		}
	}
	for (const extra of input.extraEvents ?? []) log(extra.at, extra.event);
	const kept = logged
		.filter((each) => each.at <= reach)
		.sort((a, b) => a.at - b.at)
		.slice(0, EVENTS_KEPT);
	const events = kept.map((each) => each.event);

	// What settled lately, newest last, and the batch being checked now.
	const settled: { at: number; outcome: Outcome }[] = [];
	for (const story of stories)
		for (const step of story.steps) {
			if (step.at > reach) continue;
			if (step.kind === "failed")
				settled.push({
					at: step.at,
					outcome: {
						change: story.change,
						head: mustHead(story, step.at),
						agent: story.agent,
						how: "failed",
						at: ago(step.at),
						reasons: [step.reason],
					},
				});
			else if (step.kind === "landed")
				settled.push({
					at: step.at,
					outcome: {
						change: story.change,
						head: mustHead(story, step.at),
						agent: story.agent,
						how: "landed",
						at: ago(step.at),
						commit: mergeOf(story),
					},
				});
		}
	const recent = settled.sort((a, b) => b.at - a.at).map((each) => each.outcome);
	const batch = stories.filter((story) => story.checking && !endingOf(story));
	const checking = batch.length
		? {
				base: head,
				since: ago(input.checkingSince ?? 5),
				changes: batch.map((story) => ({ change: story.change, head: mustHead(story, 0), agent: story.agent })),
			}
		: null;

	// The claims in force.
	const landedChanges = new Set(stories.filter((story) => landedAt(story) !== undefined).map((story) => story.change));
	const claims: Claim[] = [];
	const records = new Map<string, NonNullable<ChangeHistory["claim"]>>();
	for (const story of stories) {
		const reclaims = story.steps.filter((step): step is Extract<Step, { kind: "reclaim" }> => step.kind === "reclaim");
		const paths = [...story.paths, ...reclaims.flatMap((step) => step.paths ?? [])];
		const lastClaim = Math.min(story.claimed, ...reclaims.map((step) => step.at));
		const by = ownerOf(story.agent);
		const record: NonNullable<ChangeHistory["claim"]> = {
			change: story.change,
			agent: story.agent,
			paths,
			intent: story.intent,
			since: ago(story.claimed),
			active: ago(story.active ?? lastClaim),
			...(by ? { by } : {}),
			...(story.into ? { into: story.into } : {}),
			...(story.after ? { after: story.after } : {}),
		};
		records.set(story.change, record);
		if (endingOf(story)) continue;
		const claimHead = headAt(story, -Infinity);
		const approval = approvalOf(story, claimHead, votes, policyFor(input, story));
		const onHead = claimHead ? votes.filter((vote) => vote.commit === claimHead && vote.reviewer !== story.agent) : [];
		const lease = leaseFor({
			active: record.active,
			head: claimHead,
			votes: onHead.map((vote) => ({ verdict: vote.verdict, at: vote.at })),
			approved: approval.approved,
			vetoed: approval.vetoedBy.length > 0,
			landing: !!story.checking && !!claimHead,
			// A failed builder needs a person too, but it isn't a question its agent asked.
			asked: !!story.attention && story.attention.agent !== "githive-builder",
		});
		const waitsOn = (story.after ?? []).filter((dependency) => !landedChanges.has(dependency));
		const attention = story.attention;
		claims.push({
			...record,
			head: claimHead,
			...(waitsOn.length ? { waitsOn } : {}),
			approval,
			...(attention ? { attention: { reason: attention.reason, agent: attention.agent, at: ago(attention.at) } } : {}),
			...(story.hosted ? { hosted: story.hosted } : {}),
			lease,
		});
	}

	// Each change's page.
	const changes = new Map<string, ChangeHistory>();
	for (const story of stories) {
		const pushes = pushesOf.get(story.change) ?? [];
		const own = new Set(pushes.map((push) => push.commit));
		const ending = endingOf(story);
		const finalHead = headAt(story, -Infinity);
		const into = story.into ?? input.branch;
		const branchHead = story.into ? (input.otherHeads?.[story.into] ?? head) : head;
		const attempts = story.steps.flatMap((step) => (step.kind === "failed" ? [step.reason] : []));
		const merge =
			!ending && finalHead
				? (story.merge?.(finalHead, branchHead) ?? { head: finalHead, into, branchHead, clean: true })
				: undefined;
		const awareness = !ending && finalHead ? story.awareness?.(finalHead) : undefined;
		const released: ChangeHistory["released"] = ending
			? [
					{
						reason: ending.kind === "landed" ? "merged" : ending.reason,
						at: ago(ending.at),
						agent: story.agent,
						...(ending.kind === "landed" ? { mergedAs: mergeOf(story) } : {}),
						...(ending.kind === "released" && ending.stale ? { stale: true } : {}),
					},
				]
			: [];
		changes.set(story.change, {
			change: story.change,
			branch: into,
			claim: ending ? null : records.get(story.change)!,
			released,
			commits: [...pushes]
				.reverse()
				.map((push) => ({ commit: push.commit, message: push.message, author: story.agent, at: ago(push.at) })),
			votes: votes.filter((vote) => own.has(vote.commit)),
			...(merge ? { merge } : {}),
			...(attempts.length ? { attempts } : {}),
			...(awareness ? { awareness } : {}),
		});
	}

	// The project branch's history.
	const landed: LandedChange[] = onProject.map((story) => {
		const storyHead = headAt(story, -Infinity)!;
		const files = story.files ?? touched(story.paths, input.files);
		const reviews = votes
			.filter((vote) => vote.commit === storyHead && vote.verdict === "approve")
			.map((vote) => ({
				reviewer: vote.reviewer,
				role: vote.role,
				verdict: vote.verdict,
				evidence: firstLine(vote.evidence),
			}));
		return {
			commit: mergeOf(story),
			change: story.change,
			agent: story.agent,
			head: storyHead,
			title: firstLine(story.intent),
			intent: story.intent,
			files,
			filesTotal: story.filesTotal ?? files.length,
			reviews,
			at: ago(landedAt(story)!),
		};
	});

	return {
		head,
		claims,
		votes,
		events,
		checking,
		recent,
		changes,
		landed,
		lastActivity: events[0]?.at,
	};
}

/** The snapshot's votes: the newest 20, newest first. */
export const snapshotVotes = (votes: Vote[]): Vote[] => votes.slice(-20).reverse();
