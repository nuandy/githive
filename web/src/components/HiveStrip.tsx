import { useRef } from "react";
import type { LandingStretch, RepoAudit, RepoLanding, RepoSnapshot } from "../api";
import { useBumps } from "../hooks/useBumps";
import { displayName } from "../lib/agent";
import { type Goal, type Stage, stageCounts } from "../lib/goals";
import { needsYou } from "../lib/needsYou";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { type ChangeState, STATES } from "../lib/status";
import { justFinished, stretchWords } from "../lib/stretch";
import { hhmm, RANGE_WORDS } from "../lib/timeAxis";
import { cn } from "../lib/utils";
import { StateMark } from "./StateMark";
import { Lamp } from "./ui/badge";

/**
 * Each stage, by the state its swatch shows (as tall as the count's digits, and level with them), and its count's
 * color. Up next is a dashed outline; the rest are their states' marks, so the strip is the map's key.
 */
const STAGES: { stage: Stage; state?: ChangeState; count?: string }[] = [
	{ stage: "next" },
	{ stage: "building", state: "building" },
	{ stage: "review", state: "in-review" },
	{ stage: "approved", state: "approved", count: "text-good" },
	{ stage: "landing", state: "landing", count: "text-stage-landing" },
	{ stage: "landed", state: "landed", count: "text-stage-landed" },
];

/** A swatch, as tall as the digits beside it and level with them. */
const SWATCH = cn(
	"size-[1cap] rounded-sm border-[1.5px] text-title-lg",
	"supports-[not_(text-box:trim-both_cap_alphabetic)]:relative supports-[not_(text-box:trim-both_cap_alphabetic)]:-top-0.5",
);

/**
 * The top of the Hive tab: what needs a person, if anything, then how many goals are at each stage. The stages'
 * swatches key the map's colors; the map keys its red cells itself. Once everything has landed it says so instead.
 */
export function HiveStrip({
	repo,
	goals,
	upNext,
	landing,
	audit,
	snapshot,
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
	/** The claims, votes and policy, for what waits on a person (see needsYou.ts). */
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "policy">;
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
			<NeedsYou repo={repo} goals={goals} audit={audit} snapshot={snapshot} />
			{!goals.length && !justFinished(stretch, now) ? (
				<EmptyHive stretch={stretch} now={now} />
			) : (
				<ol
					className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2 p-0"
					aria-label="Goals by stage"
				>
					{stages.map(({ stage, state, count }) => (
						<li
							key={stage}
							data-stage={stage}
							className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 transition-[border-color,background-color] duration-300 ease-[ease]"
						>
							{state ? (
								<StateMark state={state} className={SWATCH} />
							) : (
								<span className={cn(SWATCH, "flex-none border-dashed border-border-strong")} aria-hidden="true" />
							)}
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
								{state ? STATES[state].short : "up next"}
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

/**
 * What waits on a person (see needsYou.ts): an agent's question, a vote only people may give, merges the audit flags.
 * Failed checks aren't here: the goal's row says its agent is fixing them.
 */
function NeedsYou({
	repo,
	goals,
	audit,
	snapshot,
}: {
	repo: string;
	goals: Goal[];
	audit: RepoAudit | undefined;
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "policy">;
}) {
	const { changes, violations } = needsYou(snapshot, audit);
	const titleOf = new Map(goals.map((goal) => [goal.change, goal.title]));
	const line =
		changes.length || violations ? (
			<p
				className={cn(
					"m-0 mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-md border border-bad/45 bg-bad-soft px-3 py-2 text-body-sm",
					"[&_a+a]:before:mr-3.5 [&_a+a]:before:text-muted-foreground [&_a+a]:before:content-['·']",
				)}
			>
				<span className="inline-flex items-center gap-2 font-bold text-bad">
					<Lamp state="needs-person" />
					{STATES["needs-person"].label}:
				</span>
				{changes.map((waiting) =>
					waiting.kind === "question" ? (
						<a key={waiting.change} href={href.change(repo, waiting.change)} title={waiting.reason}>
							{waiting.agent === "githive" ? "GitHive" : (displayName(waiting.agent) ?? waiting.agent)}
							{waiting.agent === "githive" ? ": " : " asks "}“{brief(waiting.reason)}”
						</a>
					) : (
						<a key={waiting.change} href={href.change(repo, waiting.change)}>
							{titleOf.get(waiting.change) ?? waiting.change} needs a {waiting.role} vote from a person
						</a>
					),
				)}
				{violations ? (
					<a href={href.repo(repo, "audit")}>{counted(violations, "merge")} for the audit to look at</a>
				) : null}
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
