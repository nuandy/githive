import { useRef } from "react";
import type { LandingStretch, RepoAudit, RepoLanding, RepoSnapshot } from "../api";
import { displayName } from "../lib/agent";
import { type Goal, type Stage, stageCounts } from "../lib/goals";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { justFinished, stretchWords } from "../lib/stretch";
import { hhmm, RANGE_WORDS } from "../lib/timeAxis";

const STAGES: { stage: Stage; words: string }[] = [
	{ stage: "next", words: "up next" },
	{ stage: "building", words: "building" },
	{ stage: "review", words: "in review" },
	{ stage: "landing", words: "landing" },
	{ stage: "landed", words: "landed" },
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
		<header className="hive-strip">
			<NeedsYou repo={repo} goals={goals} landing={landing} audit={audit} policy={policy} range={range} now={now} />
			{!goals.length && !justFinished(stretch, now) ? (
				<EmptyHive stretch={stretch} now={now} />
			) : (
				<ol className="hive-strip__stages" aria-label="Goals by stage">
					{stages.map(({ stage, words }) => (
						<li key={stage} className={`hive-strip__stage hive-strip__stage--${stage}`}>
							<span className="hive-strip__swatch" aria-hidden="true" />
							<b
								key={counts[stage]}
								className={bumped.has(stage) ? "hive-strip__count hive-strip__count--bump" : "hive-strip__count"}
							>
								{counts[stage]}
							</b>
							<span className="hive-strip__words">
								{words}
								{stage === "landed" ? (
									<span className="muted"> · {folded ? `since ${hhmm(since)}` : RANGE_WORDS[range]}</span>
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
 * The counts that have changed since the strip was first drawn. A count is keyed by its value, so a new value is a
 * new element; with the bump class it plays the bump as it appears, and only then. The first draw doesn't bump.
 */
function useBumps(counts: Record<Stage, number>): Set<Stage> {
	const last = useRef<Record<Stage, number> | null>(null);
	const moved = useRef(new Set<Stage>());
	const before = last.current;
	if (before)
		for (const stage of Object.keys(counts) as Stage[]) if (counts[stage] !== before[stage]) moved.current.add(stage);
	last.current = counts;
	return moved.current;
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
		<p className="hive-needs">
			<span className="hive-needs__lead">
				<span className="lamp lamp--red" aria-hidden="true" />
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
		<div className={`hive-needs-wrap${line ? " hive-needs-wrap--on" : ""}`} inert={!line}>
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
		<p className="hive-strip__recap hive-strip__appear">
			<span className="tone-good">✓ All landed.</span> {stretchWords(stretch)}, finished {timeAgo(stretch.to, now)}.{" "}
			{audit && !audit.open ? "The audit is clean. " : null}
			<a href={href.repo(repo, "history")}>See what landed</a>
		</p>
	);
}

/** No goals at all: how to bring an agent in, or when the last work finished. */
function EmptyHive({ stretch, now }: { stretch: LandingStretch | undefined; now: number }) {
	return (
		<div className="hive-strip__empty hive-strip__appear">
			<h2>No agents in the hive {stretch ? "now" : "yet"}</h2>
			<p className="muted">
				{stretch ? `Its last stretch of work finished ${timeAgo(stretch.to, now)}: ${stretchWords(stretch)}. ` : ""}
				Connect an agent from the Agents page: it claims work here, and shows up as it does.
			</p>
		</div>
	);
}
