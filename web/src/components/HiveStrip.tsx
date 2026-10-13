import { useRef } from "react";
import type { LandingStretch, RepoAudit, RepoLanding, RepoSnapshot } from "../api";
import { useBumps } from "../hooks/useBumps";
import { displayName } from "../lib/agent";
import { type Goal, type Stage, stageCounts } from "../lib/goals";
import { needsYou } from "../lib/needsYou";
import { counted } from "../lib/plural";
import { connectSteps } from "../lib/session";
import { shortAge, timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { type ChangeState, STATES } from "../lib/status";
import { justFinished, stretchWords } from "../lib/stretch";
import { hhmm, RANGE_WORDS } from "../lib/timeAxis";
import { cn } from "../lib/utils";
import { rememberedClient } from "./AgentsConnect";
import { CopyBlock } from "./CopyBlock";
import { Icon, type IconName } from "./Icon";
import { StateMark } from "./StateMark";
import { Lamp } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
	writes = false,
	origin = "",
}: {
	repo: string;
	goals: Goal[];
	/** Free backlog items, when the backlog is known. */
	upNext?: number;
	landing?: RepoLanding;
	audit?: RepoAudit;
	/** The claims, votes and review settings, for what waits on a person (see needsYou.ts). */
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "policy" | "branchRules" | "branch">;
	/** The goals panel's range: landed counts what landed within it. */
	range: number;
	/** Where the goals panel's clock starts (before now - range when quiet stretches fold). */
	since: number;
	now: number;
	/** The reader can write here: an empty hive shows how to bring an agent in. */
	writes?: boolean;
	/** Where GitHive is, for the command that connects an agent. */
	origin?: string;
}) {
	const counts = stageCounts(goals, upNext ?? 0, since);
	const folded = since < now - range;
	const inFlight = goals.filter((goal) => !goal.finished).length;
	const bumped = useBumps(counts);
	const stretch = landing?.stretch;
	const stages = STAGES.filter(({ stage }) => stage !== "next" || upNext !== undefined);
	return (
		<header>
			<NeedsYou repo={repo} goals={goals} audit={audit} snapshot={snapshot} now={now} />
			{!goals.length && !justFinished(stretch, now) ? (
				<EmptyHive repo={repo} stretch={stretch} now={now} writes={writes} origin={origin} />
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

/** How many of what needs a person the banner lists; the rest are counted, and in the Inbox. */
const NEEDS_ROWS = 3;

/** One thing that needs a person, as a row of the banner: what kind, who and when, what about, and what to do. */
interface NeedsRow {
	key: string;
	icon: IconName;
	/** Who asks or waits, and how long ago: "mara/claude asks · 38m". */
	lead: string;
	/** The question, or what the vote or audit is about, on one line. */
	text: string;
	/** Quoted: an agent's own words. */
	quoted?: boolean;
	verb: string;
	href: string;
}

/**
 * What needs a person, as the banner's rows (see needsYou.ts): agents' questions first, then votes only people may
 * give, then the audit's open violations. Failed checks aren't here: the goal's row says its agent is fixing them.
 */
export function needsRows(
	repo: string,
	goals: Goal[],
	audit: RepoAudit | undefined,
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "policy" | "branchRules" | "branch">,
	now: number,
): NeedsRow[] {
	const { changes, violations } = needsYou(snapshot, audit);
	const titleOf = new Map(goals.map((goal) => [goal.change, goal.title]));
	const activeOf = new Map(snapshot.claims.map((claim) => [claim.change, claim.active]));
	// Where a person decides: the change's page, opened at its decision.
	const decide = (change: string) => href.change(repo, change, "conversation", { decide: true });
	const rows: NeedsRow[] = changes.map((waiting) => {
		if (waiting.kind === "question") {
			const who = waiting.agent.startsWith("githive") ? "GitHive" : (displayName(waiting.agent) ?? waiting.agent);
			return {
				key: `ask:${waiting.change}`,
				icon: "comment",
				lead: `${who} ${who === "GitHive" ? "says" : "asks"} · ${shortAge(waiting.at, now)}`,
				text: waiting.reason,
				quoted: who !== "GitHive",
				verb: "Answer",
				href: decide(waiting.change),
			};
		}
		const since = activeOf.get(waiting.change);
		return {
			key: `vote:${waiting.change}`,
			icon: "user",
			lead: `${titleOf.get(waiting.change) ?? waiting.change}${since ? ` · ${shortAge(since, now)}` : ""}`,
			text: `waits for a ${waiting.role} vote, which only people may give`,
			verb: `Vote as ${waiting.role}`,
			href: decide(waiting.change),
		};
	});
	if (violations)
		rows.push({
			key: "audit",
			icon: "shield",
			lead: "The audit",
			text: `flags ${counted(violations, "merge")} to look at`,
			verb: "See the audit",
			href: href.repo(repo, "audit"),
		});
	return rows;
}

/** What needs a person: up to three rows, then how many more the Inbox has. It slides open and shut. */
function NeedsYou({
	repo,
	goals,
	audit,
	snapshot,
	now,
}: {
	repo: string;
	goals: Goal[];
	audit: RepoAudit | undefined;
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "policy" | "branchRules" | "branch">;
	now: number;
}) {
	const rows = needsRows(repo, goals, audit, snapshot, now);
	const shown = rows.slice(0, NEEDS_ROWS);
	const more = rows.length - shown.length;
	const box = rows.length ? (
		<section
			className="mb-3 rounded-md border border-bad/45 bg-bad-soft px-3 pt-2 pb-2.5"
			aria-labelledby="needs-person-title"
		>
			<h2 id="needs-person-title" className="m-0 mb-1.5 inline-flex items-center gap-2 text-body-sm font-bold text-bad">
				<Lamp state="needs-person" />
				{STATES["needs-person"].label}
			</h2>
			<ul className="m-0 grid list-none gap-1.5 p-0">
				{shown.map((row) => (
					// One line on a wide screen; on a narrow one who and the verb, then the question under them.
					<li
						key={row.key}
						className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-0.5 text-body-sm"
					>
						<Icon name={row.icon} size={14} className="relative top-0.5 row-start-1 self-start text-bad" />
						<span className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-baseline gap-x-2 to-640:contents">
							<span className="max-w-full truncate font-semibold to-640:col-start-2 to-640:row-start-1">
								{row.lead}
							</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<span
										tabIndex={0}
										className="min-w-0 flex-[1_1_14rem] truncate text-foreground to-640:col-span-2 to-640:col-start-2 to-640:row-start-2"
									>
										{row.quoted ? `“${row.text}”` : row.text}
									</span>
								</TooltipTrigger>
								<TooltipContent align="start">{row.text}</TooltipContent>
							</Tooltip>
						</span>
						<a className="col-start-3 row-start-1 font-semibold whitespace-nowrap" href={row.href}>
							{row.verb} <span aria-hidden="true">→</span>
						</a>
					</li>
				))}
			</ul>
			{more ? (
				<p className="m-0 mt-1.5 pl-6 text-ui">
					<a href={href.inbox()}>+{more} more in the Inbox</a>
				</p>
			) : null}
		</section>
	) : null;
	// The box slides open when something needs a person and shut when nothing does, showing what it last said while
	// it closes.
	const last = useRef(box);
	if (box) last.current = box;
	return (
		<div
			className={cn(
				"grid [transition:grid-template-rows_0.4s_ease,opacity_0.3s_ease] *:min-h-0 *:overflow-hidden",
				box ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
			)}
			inert={!box}
		>
			<div>{box ?? last.current}</div>
		</div>
	);
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

/** What to ask an agent once it's connected, naming the repo, ready to paste. */
export const firstPrompt = (repo: string) => `Use GitHive to find one small improvement and land it in ${repo}.`;

/**
 * No goals at all: when the last work finished, and how to bring an agent in. Someone who can write here gets it
 * ready to copy, the command that connects their agent and a prompt naming this repo, then the hive listening for
 * the first claim; a visitor, where agents come from.
 */
function EmptyHive({
	repo,
	stretch,
	now,
	writes,
	origin,
}: {
	repo: string;
	stretch: LandingStretch | undefined;
	now: number;
	writes: boolean;
	origin: string;
}) {
	const last = stretch
		? `Its last stretch of work finished ${timeAgo(stretch.to, now)}: ${stretchWords(stretch)}. `
		: "";
	if (!writes)
		return (
			<div className="animate-hive-appear">
				<h2 className="m-0 text-title-sm">No agents in the hive {stretch ? "now" : "yet"}</h2>
				<p className="m-0 mt-1 text-muted-foreground">
					{last}
					Connect an agent from the Agents page: it claims work here, and shows up as it does.
				</p>
			</div>
		);
	const connect = connectSteps(rememberedClient(), origin).find((step) => step.copy);
	return (
		<div className="grid max-w-measure animate-hive-appear gap-3">
			<div>
				<h2 className="m-0 text-title-sm">No agents in the hive {stretch ? "now" : "yet"}</h2>
				<p className="m-0 mt-1 text-muted-foreground">
					{last}
					Bring one in: connect it to GitHive, then ask it for work here.
				</p>
			</div>
			<ol className="m-0 grid list-none gap-3 p-0">
				{connect?.copy ? (
					<li className="grid gap-1.5">
						<span className="text-ui">
							<b>1.</b> {connect.text}
						</span>
						<CopyBlock text={connect.copy} label="Copy" />
						<span className="text-ui text-muted-foreground">
							Then sign in when it asks. <a href={href.agents()}>The Agents page</a> has every step, and other clients.
						</span>
					</li>
				) : null}
				<li className="grid gap-1.5">
					<span className="text-ui">
						<b>{connect?.copy ? "2." : "1."}</b> Ask it, or put your own task in its place:
					</span>
					<CopyBlock text={firstPrompt(repo)} label="Copy" />
				</li>
			</ol>
			<p className="m-0 inline-flex items-center gap-2.5 text-ui text-muted-foreground" role="status">
				<span
					aria-hidden="true"
					className="size-2 flex-none animate-live rounded-full bg-good [box-shadow:0_0_0_3px_color-mix(in_srgb,var(--good)_25%,transparent)] motion-reduce:animate-none"
				/>
				Waiting for the first claim…
			</p>
		</div>
	);
}
