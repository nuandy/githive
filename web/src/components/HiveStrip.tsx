import { useRef } from "react";
import type { LandingStretch, RepoAudit, RepoLanding, RepoSnapshot } from "../api";
import { useBumps } from "../hooks/useBumps";
import { displayName } from "../lib/agent";
import { type Goal, type Stage, stageCounts } from "../lib/goals";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { justFinished, stretchWords } from "../lib/stretch";
import { hhmm, RANGE_WORDS } from "../lib/timeAxis";
import { cn } from "../lib/utils";
import { Lamp } from "./ui/badge";

/**
 * Each stage's words, its swatch (as tall as the count's digits, and level with them) and its count's color. Up next
 * is a dashed outline, in review a dashed tint; the rest are tinted in their stage's color.
 */
const STAGES: { stage: Stage; words: string; swatch: string; count?: string }[] = [
	{ stage: "next", words: "up next", swatch: "border-dashed border-border-strong" },
	{ stage: "building", words: "building", swatch: "border-stage-building bg-stage-building/25" },
	{ stage: "review", words: "in review", swatch: "border-dashed border-stage-review bg-stage-review/8" },
	{
		stage: "landing",
		words: "landing",
		swatch: "border-stage-landing bg-stage-landing/25",
		count: "text-stage-landing",
	},
	{ stage: "landed", words: "landed", swatch: "border-stage-landed bg-stage-landed/25", count: "text-stage-landed" },
];

/**
 * The top of the Hive tab: what needs a person, if anything, then how many goals are at each stage. The stages'
 * swatches are the map's key, so the map needs no legend. Once everything has landed it says so instead.
 */
export function HiveStrip({
	repo,
	goals,
	upNext,
	landing,
	audit,
	policy,
	range,
	since,
	now,
}: {
	repo: string;
	goals: Goal[];
	/** Free backlog items, when the backlog is known. */
	upNext?: number;
	landing?: RepoLanding;
	audit?: RepoAudit;
	/** Who may vote as each role, for changes waiting on a vote only a person can give. */
	policy?: RepoSnapshot["policy"];
	/** The goals panel's range: landed counts what landed within it. */
	range: number;
	/** Where the goals panel's clock starts (before now - range when quiet stretches fold). */
	since: number;
	now: number;
}) {
	const counts = stageCounts(goals, upNext ?? 0, since);
	const folded = since < now - range;
	const inFlight = goals.filter((goal) => !goal.finished).length;
	const bumped = useBumps(counts);
	const stretch = landing?.stretch;
	const stages = STAGES.filter(({ stage }) => stage !== "next" || upNext !== undefined);
	return (
		<header>
			<NeedsYou repo={repo} goals={goals} landing={landing} audit={audit} policy={policy} range={range} now={now} />
			{!goals.length && !justFinished(stretch, now) ? (
				<EmptyHive stretch={stretch} now={now} />
			) : (
				<ol
					className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2 p-0"
					aria-label="Goals by stage"
				>
					{stages.map(({ stage, words, swatch, count }) => (
						<li
							key={stage}
							data-stage={stage}
							className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 transition-[border-color,background-color] duration-300 ease-[ease]"
						>
							<span
								className={cn(
									"size-[1cap] flex-none rounded-sm border-[1.5px] text-title-lg",
									"supports-[not_(text-box:trim-both_cap_alphabetic)]:relative supports-[not_(text-box:trim-both_cap_alphabetic)]:-top-0.5",
									swatch,
								)}
								aria-hidden="true"
							/>
							{/* The box is the digits' height, so centring it centres the digits, not the line with its descender room. */}
							<b
								key={counts[stage]}
								className={cn(
									"inline-block text-title-lg leading-none font-extrabold tabular-nums [text-box:trim-both_cap_alphabetic]",
									count,
									bumped.has(stage) && "animate-bump",
								)}
							>
								{counts[stage]}
							</b>
							<span className="text-ui text-muted-foreground">
								{words}
								{stage === "landed" ? (
									<span className="text-muted-foreground">
										{" "}
										· {folded ? `since ${hhmm(since)}` : RANGE_WORDS[range]}
									</span>
								) : null}
							</span>
						</li>
					))}
				</ol>
			)}
			{!inFlight && justFinished(stretch, now) ? (
				<AllLanded repo={repo} stretch={stretch} audit={audit} now={now} />
			) : null}
		</header>
	);
}

/** What waits on a person: an agent's question, a change its checks put out, merges the audit flags. */
function NeedsYou({
	repo,
	goals,
	landing,
	audit,
	policy,
	range,
	now,
}: {
	repo: string;
	goals: Goal[];
	landing: RepoLanding | undefined;
	audit: RepoAudit | undefined;
	policy: RepoSnapshot["policy"] | undefined;
	range: number;
	now: number;
}) {
	const asking = goals.filter((goal) => goal.state === "asking");
	const titleOf = new Map(goals.map((goal) => [goal.change, goal]));
	const failed = new Map<string, string>();
	for (const outcome of landing?.recent ?? []) {
		const goal = titleOf.get(outcome.change);
		const later = goal?.state === "landed" || goal?.state === "released";
		if (outcome.how === "failed" && !later && now - Date.parse(outcome.at) <= range)
			failed.set(outcome.change, goal?.title ?? outcome.change);
	}
	// A pushed change waiting for a role only people hold; one GitHive has already flagged is asking, above.
	const voting = goals.flatMap((goal) => {
		if (!goal.head || goal.finished || goal.state === "asking") return [];
		const role = goal.approval?.awaiting?.find((each) => peopleOnly(policy, each));
		return role ? [{ goal, role }] : [];
	});
	const flagged = audit?.open ?? 0;
	const needed = asking.length || voting.length || failed.size || flagged;
	const line = needed ? (
		<p
			className={cn(
				"m-0 mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-md border border-bad/45 bg-bad-soft px-3 py-2 text-body-sm",
				"[&_a+a]:before:mr-3.5 [&_a+a]:before:text-muted-foreground [&_a+a]:before:content-['·']",
			)}
		>
			<span className="inline-flex items-center gap-2 font-bold text-bad">
				<Lamp color="red" />
				Needs a person:
			</span>
			{asking.map((goal) => {
				const question = goal.attention?.reason ?? goal.title;
				return (
					<a key={goal.key} href={href.change(repo, goal.change)} title={question}>
						{goal.attention?.agent === "githive" ? "GitHive" : (displayName(goal.attention?.agent) ?? goal.agent)}
						{goal.attention?.agent === "githive" ? ": " : " asks "}“{brief(question)}”
					</a>
				);
			})}
			{voting.map(({ goal, role }) => (
				<a key={goal.key} href={href.change(repo, goal.change)}>
					{goal.title} needs a {role} vote from a person
				</a>
			))}
			{[...failed].map(([change, title]) => (
				<a key={change} href={href.change(repo, change)}>
					{title}: its checks failed
				</a>
			))}
			{flagged ? <a href={href.repo(repo, "audit")}>{counted(flagged, "merge")} for the audit to look at</a> : null}
		</p>
	) : null;
	// The line slides open when something needs a person and shut when nothing does, showing what it last said
	// while it closes.
	const last = useRef(line);
	if (line) last.current = line;
	return (
		<div
			className={cn(
				"grid [transition:grid-template-rows_0.4s_ease,opacity_0.3s_ease] *:min-h-0 *:overflow-hidden",
				line ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
			)}
			inert={!line}
		>
			<div>{line ?? last.current}</div>
		</div>
	);
}

/** How much of a question the line quotes; the rest is in its tooltip and on the change's page. */
const QUOTED = 90;

const brief = (text: string) => (text.length > QUOTED ? `${text.slice(0, text.lastIndexOf(" ", QUOTED - 1))}…` : text);

/** Whether only people may vote as a role: no agent, pool or GitHive reviewer holds it (see grantWarnings). */
function peopleOnly(policy: RepoSnapshot["policy"] | undefined, role: string): boolean {
	const holders = policy?.grants?.[role] ?? ["person:*", "githive"];
	const person = (holder: string) => holder === "person:*" || /^person:[^/]+$/.test(holder) || holder.startsWith("@");
	return holders.length > 0 && holders.every(person);
}

/** The recap once a stretch of work has landed and nothing's in flight. */
function AllLanded({
	repo,
	stretch,
	audit,
	now,
}: {
	repo: string;
	stretch: LandingStretch;
	audit?: RepoAudit;
	now: number;
}) {
	return (
		<p className="m-0 mt-2.5 animate-hive-appear border-l-3 border-good pl-3">
			<span className="text-good">✓ All landed.</span> {stretchWords(stretch)}, finished {timeAgo(stretch.to, now)}.{" "}
			{audit && !audit.open ? "The audit is clean. " : null}
			<a href={href.repo(repo, "history")}>See what landed</a>
		</p>
	);
}

/** No goals at all: how to bring an agent in, or when the last work finished. */
function EmptyHive({ stretch, now }: { stretch: LandingStretch | undefined; now: number }) {
	return (
		<div className="animate-hive-appear">
			<h2 className="m-0 text-title-sm">No agents in the hive {stretch ? "now" : "yet"}</h2>
			<p className="m-0 mt-1 text-muted-foreground">
				{stretch ? `Its last stretch of work finished ${timeAgo(stretch.to, now)}: ${stretchWords(stretch)}. ` : ""}
				Connect an agent from the Agents page: it claims work here, and shows up as it does.
			</p>
		</div>
	);
}
