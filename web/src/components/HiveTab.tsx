import type { BacklogItem, DemoRunStatus, HiveEvent, RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnnouncer } from "../hooks/useAnnouncer";
import { usePoll } from "../hooks/usePoll";
import { freeWork, type Goal, hiveGoals } from "../lib/goals";
import { hiveCells } from "../lib/hiveCells";
import { announcement, type GoalMotion, goalMotions, MOTION_MS } from "../lib/hiveMotion";
import { motionMs } from "../lib/motion";
import { chooseRange, DEFAULT_RANGE, timeAxis } from "../lib/timeAxis";
import { DemoBanner } from "./DemoRun";
import { GoalsPanel } from "./GoalsPanel";
import { HiveMap } from "./HiveMap";
import { HiveStrip } from "./HiveStrip";
import { Announcer } from "./ui/announcer";

export interface HiveApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	landing?: (repo: string, branch: string) => Promise<RepoLanding>;
	events?: (repo: string) => Promise<{ events: HiveEvent[] }>;
	/** The latest demo run on the repo, if it's the demo repo. */
	demoRun?: (repo: string) => Promise<DemoRunStatus>;
}

/** The Hive tab: what each agent working on the repo's branch set out to do, what became of it, and where. */
export function HiveTab({
	repo,
	branch,
	snapshot,
	api,
}: {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	api: HiveApi;
}) {
	const load = api.landing;
	const landing = usePoll(load ? `landing:${repo}:${branch}` : null, () => load!(repo, branch), 5_000);
	const tree = usePoll(`tree:${repo}:${branch}`, () => api.tree(repo), 60_000);
	const loadEvents = api.events;
	const events = usePoll(loadEvents ? `events:${repo}` : null, () => loadEvents!(repo), 10_000);
	// The snapshot is read again on each ping from the live feed, so the events follow it.
	const refreshEvents = events.refresh;
	useEffect(() => refreshEvents(), [snapshot.claims, refreshEvents]);
	// Only the claims landing on this branch: each change lands on one branch.
	const onBranch = { ...snapshot, claims: snapshot.claims.filter((claim) => (claim.into ?? branch) === branch) };
	const elsewhere = new Set(
		snapshot.claims.filter((claim) => (claim.into ?? branch) !== branch).map((claim) => claim.change),
	);
	const loadDemo = api.demoRun;
	return (
		<>
			{loadDemo ? <DemoBanner repo={repo} load={loadDemo} changed={snapshot.claims} /> : null}
			<Hive
				repo={repo}
				branch={branch}
				snapshot={onBranch}
				elsewhere={elsewhere}
				{...(landing.data ? { landing: landing.data } : {})}
				{...(landing.error ? { landingError: String(landing.error) } : {})}
				{...(tree.data ? { tree: tree.data } : {})}
				{...(tree.error ? { treeError: String(tree.error) } : {})}
				{...(events.data ? { events: events.data.events } : {})}
				{...(events.error ? { eventsError: String(events.error) } : {})}
				showsLanding={!!load}
				showsFeed={!!loadEvents}
			/>
		</>
	);
}

export interface HiveProps {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	landing?: RepoLanding;
	landingError?: string;
	tree?: RepoTree;
	treeError?: string;
	showsLanding?: boolean;
	events?: HiveEvent[];
	eventsError?: string;
	showsFeed?: boolean;
	/** The repo's backlog, where the server gives one (the playground does). */
	backlog?: BacklogItem[];
	/** Changes landing on other branches, left out of this one's goals. */
	elsewhere?: Set<string>;
	/** The time everything counts from (tests and the playground fix it). */
	now?: number;
}

/** What links the map and the goals: a goal or a cell pointed at, and what the goals are filtered to. */
export type HiveFilter =
	{ kind: "agent"; agent: string } | { kind: "cell"; key: string; label: string; goals: string[] };

/** The hive as drawn, from what's been loaded. */
export function Hive(props: HiveProps) {
	const { repo, branch, snapshot, landing, events, backlog, now = Date.now() } = props;
	const remembered = useRemembered(snapshot.claims);
	const goals = useMemo(
		() =>
			hiveGoals({
				claims: snapshot.claims,
				votes: snapshot.votes,
				...(events ? { events } : {}),
				...(landing ? { landing } : {}),
				...(props.elsewhere ? { elsewhere: props.elsewhere } : {}),
				remembered,
			}),
		[snapshot.claims, snapshot.votes, events, landing, props.elsewhere, remembered],
	);
	const upNext = useMemo(() => (backlog ? freeWork(backlog, goals) : undefined), [backlog, goals]);
	const cells = useMemo(
		() => (props.tree ? hiveCells(props.tree.files, goals, upNext ?? [], now) : undefined),
		[props.tree, goals, upNext, now],
	);
	const { motions, unseen, seen, said } = useMotions(goals, now);
	// The range is picked once, from the first goals read with the event log in, and after that only by the person.
	// Before the log arrives the landing alone knows when goals finished but not when they began, so they'd look
	// shorter than they were.
	const [picked, setPicked] = useState<number | null>(null);
	const auto = useRef<number | null>(null);
	const logIn = !props.showsFeed || events !== undefined || props.eventsError !== undefined;
	if (auto.current === null && logIn && goals.length) auto.current = chooseRange(goals, now);
	const range = picked ?? auto.current ?? DEFAULT_RANGE;
	// Where the goals' clock starts: the range back from now, and further when quiet stretches fold.
	const since = timeAxis(goals, range, now).start;
	const [hovered, setHovered] = useState<{ goal?: string; cell?: string }>({});
	const [filter, setFilter] = useState<HiveFilter | null>(null);
	const litCells = new Set(
		hovered.goal
			? (cells?.clusters.flatMap((cluster) => cluster.cells) ?? [])
					.filter((cell) => cell.goals.includes(hovered.goal!))
					.map((cell) => cell.key)
			: [],
	);
	const hoveredCell = hovered.cell
		? cells?.clusters.flatMap((cluster) => cluster.cells).find((cell) => cell.key === hovered.cell)
		: undefined;
	const litGoals = new Set(hoveredCell?.goals ?? []);
	return (
		<div className="grid gap-4">
			<HiveStrip
				repo={repo}
				goals={goals}
				{...(upNext ? { upNext: upNext.length } : {})}
				{...(landing ? { landing } : {})}
				{...(snapshot.audit ? { audit: snapshot.audit } : {})}
				policy={snapshot.policy}
				range={range}
				since={since}
				now={now}
			/>
			{/* The hive beside the goals; on narrow screens, under them. */}
			<div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-5 to-1100:grid-cols-[minmax(0,1fr)]">
				{/* The map stays in view while the goals scroll past it. */}
				<div className="sticky top-[calc(var(--topbar-height)+12px)] to-1100:static to-1100:order-2">
					<HiveMap
						repo={repo}
						branch={branch}
						{...(cells ? { cells } : {})}
						{...(props.tree?.truncated ? { truncated: true } : {})}
						{...(props.treeError ? { error: props.treeError } : {})}
						lit={litCells}
						filter={filter}
						motions={motions}
						onHover={(cell) => setHovered(cell ? { cell } : {})}
						onPick={(cell) =>
							setFilter((current) =>
								current?.kind === "cell" && current.key === cell.key
									? null
									: {
											kind: "cell",
											key: cell.key,
											label: cell.kind === "folder" ? `${cell.path}/` : cell.path || "top files",
											goals: cell.goals,
										},
							)
						}
						now={now}
					/>
				</div>
				<GoalsPanel
					repo={repo}
					branch={branch}
					goals={goals}
					range={range}
					onRange={setPicked}
					{...(props.eventsError ? { error: props.eventsError } : {})}
					lit={litGoals}
					filter={filter}
					onFilter={setFilter}
					motions={motions}
					unseen={unseen}
					onSeen={seen}
					onHover={(goal) => setHovered(goal ? { goal } : {})}
					now={now}
				/>
			</div>
			<Announcer said={said} />
		</div>
	);
}

/**
 * The paths of every claim seen while the page is open, by change. Once a change lands its claim is gone, and
 * nothing else the server sends says what it touched, so the map would forget who built what.
 */
function useRemembered(claims: RepoSnapshot["claims"]): Map<string, string[]> {
	const seen = useRef(new Map<string, string[]>());
	return useMemo(() => {
		for (const claim of claims) seen.current.set(claim.change, claim.paths);
		return new Map(seen.current);
	}, [claims]);
}

/**
 * What's moving now, by change, from comparing each read of the goals with the last one drawn. While the tab is
 * hidden nothing plays; what changed meanwhile is marked unseen until it's looked at.
 */
function useMotions(goals: Goal[], now: number) {
	const drawn = useRef<Goal[] | undefined>(undefined);
	const [motions, setMotions] = useState<Map<string, GoalMotion & { seq: number }>>(new Map());
	const [unseen, setUnseen] = useState<Set<string>>(new Set());
	const { said, say } = useAnnouncer();
	const seq = useRef(0);
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	useEffect(() => {
		const before = drawn.current;
		drawn.current = goals;
		const found = goalMotions(before, goals, now);
		if (!found.length) return;
		if (typeof document !== "undefined" && document.hidden) {
			setUnseen((current) => new Set([...current, ...found.map((motion) => motion.key)]));
			return;
		}
		const started = found.map((motion) => ({ ...motion, seq: ++seq.current }));
		setMotions((current) => {
			const next = new Map(current);
			for (const motion of started) next.set(motion.key, motion);
			return next;
		});
		const words = started
			.map((motion) => {
				const goal = goals.find((each) => each.key === motion.key);
				return goal ? announcement(goal, motion.motion) : undefined;
			})
			.filter(Boolean);
		// A screen reader hears at most one announcement every few seconds, however busy the hive.
		say(words.join(". "));
		// Each motion's class comes off once it has played (at once under reduced motion, where none plays); a newer
		// read mustn't cancel that.
		for (const motion of started) {
			const timer = setTimeout(
				() => {
					timers.current.delete(timer);
					setMotions((current) => {
						if (current.get(motion.key)?.seq !== motion.seq) return current;
						const next = new Map(current);
						next.delete(motion.key);
						return next;
					});
				},
				motionMs(motion.delay + MOTION_MS[motion.motion]),
			);
			timers.current.add(timer);
		}
		// `now` moves every tick; only a new read of the goals is compared.
	}, [goals]);
	useEffect(() => () => timers.current.forEach(clearTimeout), []);
	const seen = (change: string) =>
		setUnseen((current) => {
			if (!current.has(change)) return current;
			const next = new Set(current);
			next.delete(change);
			return next;
		});
	return { motions, unseen, seen, said };
}
