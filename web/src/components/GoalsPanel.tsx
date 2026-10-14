import { type CSSProperties, type MouseEvent, type RefObject, useEffect, useReducer, useRef, useState } from "react";
import { useFresh } from "../hooks/useFresh";
import { useGlide } from "../hooks/useGlide";
import { useLingering } from "../hooks/useLingering";
import { useWidth } from "../hooks/useWidth";
import { displayName } from "../lib/agent";
import { distinctTitles, type Goal, type GoalStep, goalStatus } from "../lib/goals";
import { agentChip, agentHue, HUE_BORDER } from "../lib/hiveCells";
import { type GoalLayout, type GoalMotion, holdLayout, type Motion, pendingWords } from "../lib/hiveMotion";
import { briefPaths, shortSha, timeOf } from "../lib/model";
import { counted } from "../lib/plural";
import { clockTime, timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { durationWords } from "../lib/stretch";
import {
	type Axis,
	type Bar,
	type BarMark,
	type BarPhase,
	goalBar,
	quietWords,
	ticksThatFit,
	RANGE_WORDS,
	RANGES,
	timeAxis,
} from "../lib/timeAxis";
import { cn } from "../lib/utils";
import type { HiveFilter } from "./HiveTab";
import { Button } from "./ui/button";
import { Segmented } from "./ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// The goals panel: one row per goal, in flight on top (newest arrival first), finished below. Story reads in words,
// with a slim bar on the shared clock; Timeline is the same rows, morphed, the bars taking the room. Rows never jump:
// a new goal comes in at the top, a landed one stays a minute before it moves down to Finished. And nothing moves
// under someone reading: while the pointer or focus is in the panel, or a row is open, new goals and goals that
// finished wait behind a quiet "2 new", which brings them in, as leaving the panel does.
//
// The morph is transitions, so a row changes shape instead of being drawn again: switching narrows the words column
// (--words), packs the rows (--row-pad), folds the second line away and lets the bars take the room, each in 0.45s.
// In Story the bars keep to about 120px beside titles of up to two lines, and on a narrow screen go under them.

type View = "story" | "timeline";

/** How long a finished goal stays among those in flight, so it doesn't vanish from under the reader. */
export const SETTLE_MS = 60_000;
/** Longer, while the pointer is on it. */
const HELD_MS = 5 * 60_000;

const VIEW_KEY = "githive.hive.view";

const TONE_CLASS = {
	accent: "text-link",
	amber: "text-warn",
	good: "text-good",
	bad: "text-bad",
	muted: "text-muted-foreground",
} as const;

/** What folds to its content's height and fades, grid rows 0fr ↔ 1fr around its one child. */
const FOLD = "grid *:min-h-0 *:overflow-hidden";
const FOLDS = "[transition:grid-template-rows_0.45s_ease,opacity_0.3s_ease]";
/** A note among the rows, fading in. */
const NOTE = "mx-2 my-1.5 animate-hive-fade-in text-ui text-muted-foreground";
/** A section's heading, in small capitals and ruled to the panel's edge, with room above it. */
const SECTION =
	"flex items-center gap-2.5 text-micro font-bold tracking-[0.06em] text-muted-foreground uppercase [transition:margin_0.45s_ease] after:order-1 after:h-px after:flex-1 after:bg-border";
const sectionRoom = (timeline: boolean) => (timeline ? "mx-0 mt-1.5 mb-0.5" : "mx-0 mt-2.5 mb-1");
/** A row's line: the agent's chip, then the chevron, the words and the bar. */
const LINE = "flex items-center gap-1.5 px-2";
/** What holds the words and the bar; in Story on a narrow screen the bar goes under the words. */
const MAIN = "flex min-w-0 flex-1 items-center justify-start gap-x-2.5 p-0 text-left whitespace-normal";
const MAIN_STORY = "to-640:flex-wrap to-640:gap-y-1";
/** The words column, as wide as the view gives it. */
const WORDS = "w-(--words) min-w-0 flex-none [transition:width_0.45s_ease]";
/** A row's frame: it folds shut when left out, and its edge and fill fade as it's pointed at or opened. */
const ROW =
	"grid rounded-md [transition:grid-template-rows_0.35s_ease,opacity_0.3s_ease,border-width_0.35s_ease,background-color_0.2s_ease,border-color_0.2s_ease]";
/** The edge of a row that needs a person: its agent asks one, or it waits on a vote only people give. */
const RED_EDGE = "border-[color-mix(in_srgb,var(--bad)_45%,transparent)]";
/** Everything on the clock glides when the range changes or time moves it, rather than jumping. */
const GLIDES = "[transition:left_0.45s_ease,width_0.45s_ease,opacity_0.3s_ease]";

/**
 * The agent's chip: its short name in a ring of its own hue (the map's chips wear the same), smaller in Timeline. Its
 * letters are 10px either way.
 */
const chipBox = (timeline: boolean, agent?: string) =>
	cn(
		timeline ? "size-5" : "size-6",
		"flex-none rounded-[50%] border-[1.5px] bg-card p-0 text-[10px] leading-none font-bold text-foreground",
		agent ? HUE_BORDER[agentHue(agent)] : "border-foreground",
		"[transition:width_0.45s_ease,height_0.45s_ease]",
	);

/** What just happened to a goal, on its row: it arrives, or flashes red or green. */
const ROW_MOTION: Partial<Record<Motion, string>> = {
	arrived: "animate-goal-arrive",
	"changes-asked": "animate-goal-flash-bad",
	failed: "animate-goal-flash-bad",
	asking: "animate-goal-flash-bad",
	landed: "animate-goal-flash-good",
};

export interface GoalsPanelProps {
	repo: string;
	branch: string;
	goals: Goal[];
	range: number;
	onRange(range: number): void;
	error?: string;
	/** Goals in the cell pointed at on the map. */
	lit: Set<string>;
	filter: HiveFilter | null;
	onFilter(filter: HiveFilter | null): void;
	motions: Map<string, GoalMotion & { seq: number }>;
	unseen: Set<string>;
	onSeen(change: string): void;
	onHover(change: string | null): void;
	now: number;
	/**
	 * Story or Timeline: with `onView`, the one the address asks for, else the one remembered in this browser; without
	 * it, the view to start in where there's no remembered one (tests).
	 */
	view?: View | undefined;
	onView?(view: View): void;
	/** The row the address opens, and telling it which row was opened last (or that it was closed). */
	row?: string | undefined;
	onRow?(row: string | undefined): void;
}

export function GoalsPanel(props: GoalsPanelProps) {
	const { repo, branch, goals, range, filter, now } = props;
	const [ownView, setOwnView] = useView(props.view);
	const view = props.onView ? (props.view ?? ownView) : ownView;
	const setView = (next: View) => {
		setOwnView(next);
		props.onView?.(next);
	};
	const timeline = view === "timeline";
	const [open, setOpen] = useState<Set<string>>(() => new Set(props.row ? [props.row] : []));
	// A row the address names opens, when the page opens and whenever the address changes to it.
	const linked = props.row;
	useEffect(() => {
		if (linked) setOpen((current) => (current.has(linked) ? current : new Set([...current, linked])));
	}, [linked]);
	const [showFinished, setShowFinished] = useState(false);
	const [held, setHeld] = useState<string | null>(null);
	const panel = useRef<HTMLElement>(null);
	const axis = timeAxis(goals, range, now);
	const finishedAt = (goal: Goal) => timeOf(goal.finished) ?? 0;
	const settling = (goal: Goal) =>
		!!goal.finished && (now - finishedAt(goal) < SETTLE_MS || (held === goal.key && now - finishedAt(goal) < HELD_MS));
	// Every goal keeps its row. One the filter or the range leaves out folds away rather than vanishing, so nothing
	// appears or disappears at once.
	const live: GoalLayout = {
		inFlight: goals.filter((goal) => !goal.finished || settling(goal)).map((goal) => goal.key),
		done: goals
			.filter((goal) => goal.finished && !settling(goal))
			.sort((a, b) => finishedAt(b) - finishedAt(a))
			.map((goal) => goal.key),
	};
	// Held still while someone reads: the pointer or focus is in the panel, or a row is open.
	const [pointerIn, setPointerIn] = useState(false);
	const focusIn = useFocusWithin(panel);
	// What the keyboard comes back to when the control it was on goes (see keepFocus).
	const goalsTitle = useRef<HTMLHeadingElement>(null);
	const inFlightTitle = useRef<HTMLSpanElement>(null);
	// Finished folds into a summary line in Story until it's opened; Timeline unfolds it, since the whole stretch is
	// the point there. An open row folded away in it holds nothing still.
	const finishedShown = timeline || showFinished;
	const { shown, arrived, finished, apply } = useHeld(
		live,
		(drawn) =>
			pointerIn ||
			focusIn ||
			[...open].some((key) => drawn.inFlight.includes(key) || (finishedShown && drawn.done.includes(key))),
	);
	const byKey = new Map(goals.map((goal) => [goal.key, goal]));
	const inFlight = shown.inFlight.flatMap((key) => byKey.get(key) ?? []);
	const done = shown.done.flatMap((key) => byKey.get(key) ?? []);
	const inRange = (goal: Goal) => finishedAt(goal) >= axis.start;
	const flying = inFlight.filter((goal) => matches(goal, filter));
	const landed = done.filter((goal) => matches(goal, filter) && inRange(goal));
	const earlier = done.filter((goal) => matches(goal, filter) && !inRange(goal)).length;
	const working = flying.filter((goal) => !goal.finished).length;
	// No goal at all yet: a sample of what one will look like, instead of an empty clock ticking along.
	const empty = !goals.length;
	const sample = useLingering(empty, 500);
	// Rows glide to where they now are when a goal arrives or moves down to Finished.
	useGlide(
		panel,
		`${inFlight.map((goal) => goal.key).join(" ")} | ${done.map((goal) => goal.key).join(" ")}`,
		"li[data-key]",
	);
	// A row that comes in without a motion of its own (brought in from behind "2 new") fades in where it lands.
	const fresh = useFresh(true, 400);
	// Titles that start alike fold their shared start, so what tells them apart comes first.
	const titles = new Map(
		distinctTitles(goals.map((goal) => goal.title)).map((title, index) => [goals[index]!.key, title]),
	);
	const toggle = (key: string) => {
		props.onSeen(key);
		if (!open.has(key)) props.onRow?.(key);
		else if (key === props.row) props.onRow?.(undefined);
		setOpen((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const row = (goal: Goal, shows: boolean) => (
		<GoalRow
			key={goal.key}
			repo={repo}
			branch={branch}
			goal={goal}
			title={titles.get(goal.key) ?? goal.title}
			axis={axis}
			timeline={timeline}
			hidden={!shows}
			open={open.has(goal.key)}
			onToggle={() => toggle(goal.key)}
			lit={props.lit.has(goal.key)}
			motion={props.motions.get(goal.key)}
			appearing={fresh(goal.key)}
			unseen={props.unseen.has(goal.key)}
			onHover={(hovering) => {
				setHeld(hovering ? goal.key : null);
				props.onHover(hovering ? goal.key : null);
				if (hovering) props.onSeen(goal.key);
			}}
			onAgent={(agent) =>
				props.onFilter(filter?.kind === "agent" && filter.agent === agent ? null : { kind: "agent", agent })
			}
			now={now}
		/>
	);
	return (
		<section
			ref={panel}
			data-view={view}
			onPointerEnter={() => setPointerIn(true)}
			onPointerLeave={() => setPointerIn(false)}
			className={cn(
				"min-w-0",
				timeline ? "[--row-pad:2px] [--words:26%]" : "[--row-pad:7px] [--words:calc(100%-130px)] to-640:[--words:100%]",
			)}
			aria-labelledby="goals-title"
		>
			<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<h2 id="goals-title" ref={goalsTitle} tabIndex={-1} className="m-0 text-lead focus:outline-none">
					Goals
				</h2>
				<span className="text-muted-foreground">{working ? `${working} in flight` : "nothing in flight"}</span>
				{filter ? (
					<Button
						className="animate-hive-pop-in rounded-full border-link bg-link-soft px-2.5 py-px text-caption leading-5 font-semibold text-link"
						onClick={(event) => {
							keepFocus(event, goalsTitle);
							props.onFilter(null);
						}}
						aria-label={`${filter.kind === "agent" ? `Only ${filter.agent}` : `Only ${filter.label}`}: show every goal`}
					>
						{filter.kind === "agent" ? `only ${filter.agent}` : `only ${filter.label}`}{" "}
						<span aria-hidden="true">×</span>
					</Button>
				) : null}
				{/* With nothing to act on, the range and view controls fade out. */}
				<div
					className={cn(
						"ml-auto flex gap-2 [transition:opacity_0.3s_ease,visibility_0.3s]",
						empty && "invisible opacity-0",
					)}
					inert={empty}
				>
					<Segmented
						label="Time range"
						options={RANGES.map((option) => ({ value: option, words: RANGE_WORDS[option] ?? "" }))}
						value={range}
						onPick={props.onRange}
					/>
					<Segmented
						label="View"
						options={[
							{ value: "story" as const, words: "Story" },
							{ value: "timeline" as const, words: "Timeline" },
						]}
						value={view}
						onPick={setView}
					/>
				</div>
			</div>
			{props.error ? (
				<p className={NOTE}>The event log couldn't be read ({props.error}), so steps may be missing.</p>
			) : null}
			{/* The sample and the goals themselves fold into each other as the first goal arrives. */}
			<div className={cn(FOLD, FOLDS, empty ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0")} inert={!empty}>
				<div>{sample ? <EmptyGoals timeline={timeline} /> : null}</div>
			</div>
			<div className={cn(FOLD, FOLDS, empty ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]")} inert={empty}>
				<div>
					<AxisRow axis={axis} timeline={timeline} />
					<div className={cn(SECTION, sectionRoom(timeline))}>
						<span ref={inFlightTitle} tabIndex={-1} className="focus:outline-none">
							In flight · {working}
						</span>
						{arrived.length || finished.length ? (
							// Quiet, and no taller than the heading, so its coming moves nothing.
							<Button
								key="pending"
								className={cn(
									"order-2 -my-1 animate-hive-pop-in rounded-full border-link/40 bg-link-soft px-2.5 py-0",
									"text-caption leading-5 font-semibold tracking-normal text-link normal-case",
								)}
								onClick={(event) => {
									keepFocus(event, inFlightTitle);
									apply();
								}}
								aria-label={`${pendingWords(arrived, finished)}: show them`}
							>
								{pendingWords(arrived, finished)}
							</Button>
						) : null}
					</div>
					<ol className="m-0 list-none p-0">{inFlight.map((goal) => row(goal, matches(goal, filter)))}</ol>
					{flying.length ? null : (
						<p className={NOTE}>
							{filter ? "Nothing in flight here." : "Nothing in flight now."}
							{filter ? (
								<>
									{" "}
									<Button
										variant="link"
										className="leading-[inherit]"
										onClick={(event) => {
											keepFocus(event, inFlightTitle);
											props.onFilter(null);
										}}
									>
										Show every goal
									</Button>
								</>
							) : null}
						</p>
					)}
					{done.length ? (
						// Finished as a whole folds away when the filter leaves nothing in it.
						<div
							className={cn(FOLD, FOLDS, landed.length ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0")}
							inert={!landed.length}
						>
							<div>
								<div className={cn(SECTION, sectionRoom(timeline))}>
									<span>Finished · {landed.length}</span>
									<Button
										variant="link"
										className={cn(
											"order-2 text-caption leading-[inherit] tracking-normal normal-case",
											"transition-[opacity,visibility] duration-300 ease-[ease]",
											showFinished && !timeline ? "" : "invisible opacity-0",
										)}
										onClick={() => setShowFinished(false)}
									>
										fold
									</Button>
								</div>
								<div className={cn(FOLD, FOLDS, finishedShown ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]")}>
									<div>
										<button
											type="button"
											className={cn(
												"flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border border-dashed border-border-strong",
												"bg-transparent px-2.5 py-[7px] text-left [font-family:inherit] text-ui leading-5 font-normal whitespace-normal",
												"text-foreground no-underline [transition:border-color_0.2s_ease,background-color_0.2s_ease]",
												"hover:bg-surface-2",
											)}
											onClick={() => setShowFinished(true)}
											aria-expanded={showFinished}
										>
											<FinishedWords goals={landed} />
											<span className="text-link">show</span>
										</button>
									</div>
								</div>
								<div
									className={cn(
										FOLD,
										"[transition:grid-template-rows_0.45s_ease]",
										finishedShown ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
									)}
								>
									<ol className="m-0 list-none p-0">
										{done.map((goal) => row(goal, matches(goal, filter) && inRange(goal)))}
									</ol>
								</div>
							</div>
						</div>
					) : null}
					{earlier ? (
						<p className={NOTE}>
							{counted(earlier, "goal")} finished before the range. <a href={href.repo(repo, "history")}>See History</a>
						</p>
					) : null}
				</div>
			</div>
		</section>
	);
}

/**
 * Whether the focus is in an element, asked of the document rather than told by its blur: an element removed while it
 * has the focus ("2 new" once it's clicked, the filter's chip once cleared) never says it lost it. So it's asked again
 * after every render, too.
 */
function useFocusWithin(ref: RefObject<HTMLElement | null>): boolean {
	const [inside, setInside] = useState(false);
	useEffect(() => {
		const focused = (event: FocusEvent) => setInside(!!ref.current?.contains(event.target as Node));
		const left = (event: FocusEvent) => setInside(!!ref.current?.contains(event.relatedTarget as Node | null));
		document.addEventListener("focusin", focused);
		document.addEventListener("focusout", left);
		return () => {
			document.removeEventListener("focusin", focused);
			document.removeEventListener("focusout", left);
		};
	}, [ref]);
	useEffect(() => {
		const now = !!ref.current?.contains(document.activeElement);
		if (now !== inside) setInside(now);
	});
	return inside;
}

/**
 * A control that goes once it's used ("2 new", the filter's chip) hands the keyboard's focus to a heading that stays,
 * so the reader keeps their place in the panel. A click lets it go with the control: the pointer says where the
 * reader is.
 */
function keepFocus(event: MouseEvent, to: RefObject<HTMLElement | null>) {
	// A click from Enter or Space, or a screen reader's, has no pointer's count of clicks.
	if (event.detail === 0) to.current?.focus({ preventScroll: true });
}

/**
 * The rows as drawn: as they are, or held still while `paused` says so of the rows drawn last (see holdLayout), with
 * what waits and a way to bring it in now.
 */
function useHeld(live: GoalLayout, paused: (drawn: GoalLayout) => boolean) {
	const drawn = useRef<GoalLayout | undefined>(undefined);
	const latest = useRef(live);
	latest.current = live;
	const [, redraw] = useReducer((count: number) => count + 1, 0);
	const held = holdLayout(drawn.current, live, !!drawn.current && paused(drawn.current));
	drawn.current = held.shown;
	const apply = () => {
		drawn.current = latest.current;
		redraw();
	};
	return { ...held, apply };
}

/** Before any goal: a sample row, saying what each one will show and where agents come from. */
function EmptyGoals({ timeline }: { timeline: boolean }) {
	return (
		<div className="pt-2 pb-1">
			{/* A picture of a goal rather than one: marked as an example, dashed, its bars faint. Its words keep muted
			    text's contrast. */}
			<div
				className={cn(ROW, "pointer-events-none grid-rows-[1fr] border border-dashed border-border-strong")}
				aria-hidden="true"
			>
				<div className="min-h-0 overflow-hidden">
					<span className="block px-2 pt-1.5 text-micro font-bold tracking-[0.06em] text-muted-foreground uppercase">
						Example
					</span>
					<div className={cn(LINE, "py-(--row-pad) [transition:padding_0.45s_ease]")}>
						<span
							className={cn(
								chipBox(timeline),
								"grid place-items-center border-dashed border-border-strong text-muted-foreground",
							)}
						>
							?
						</span>
						<span className="-mx-0.5 inline-grid size-5 flex-none place-items-center">
							<Chevron />
						</span>
						<span className={cn(MAIN, !timeline && MAIN_STORY)}>
							<span className={WORDS}>
								<span className={cn(titleClass(timeline), "text-muted-foreground")}>What an agent sets out to do</span>
								<span className={metaClass(timeline)}>where it stands · which agent · how long it took</span>
							</span>
							<span className={cn(TRACK, "opacity-55", !timeline && "to-640:min-h-3 to-640:basis-full")}>
								<span className={phaseClass("building")} style={{ left: "38%", width: "24%" }} />
								<span className={phaseClass("review")} style={{ left: "62%", width: "16%" }} />
								<span className={markClass("approved", true, timeline)} style={{ left: "78%" }} />
								<span className={phaseClass("landing")} style={{ left: "78%", width: "8%" }} />
								<span className={endClass("landed")} style={{ left: "86%" }}>
									✓
								</span>
							</span>
						</span>
					</div>
				</div>
			</div>
			<p className={NOTE}>
				No goals yet. Each change an agent claims here becomes a row: what it set out to do, where it stands, and what
				became of it. <a href={href.agents()}>Connect an agent</a>
			</p>
		</div>
	);
}

function matches(goal: Goal, filter: HiveFilter | null): boolean {
	if (!filter) return true;
	if (filter.kind === "agent") return goal.agent === filter.agent;
	return filter.goals.includes(goal.key);
}

/** Story or Timeline, remembered in this browser: the default where the address doesn't say. */
function useView(initial: View = "story"): [View, (view: View) => void] {
	const [view, setView] = useState<View>(() => {
		try {
			const kept = typeof localStorage === "undefined" ? null : localStorage.getItem(VIEW_KEY);
			return kept === "timeline" || kept === "story" ? kept : initial;
		} catch {
			return initial;
		}
	});
	const pick = (next: View) => {
		setView(next);
		try {
			localStorage.setItem(VIEW_KEY, next);
		} catch {
			// Private windows may refuse; the view still changes.
		}
	};
	return [view, pick];
}

/** "✓ 2 landed · 1 released", and the first few titles. */
function FinishedWords({ goals }: { goals: Goal[] }) {
	const landed = goals.filter((goal) => goal.state === "landed").length;
	const released = goals.length - landed;
	const titles = goals.slice(0, 3).map((goal) => goal.title);
	const more = goals.length - titles.length;
	return (
		<span className="truncate">
			{landed ? <b className="text-good">✓ {landed} landed</b> : null}
			{landed && released ? " · " : null}
			{released ? <b>{released} released</b> : null}
			<span className="text-muted-foreground">
				{" "}
				{titles.join(", ")}
				{more ? `, and ${more} more` : ""}
			</span>
		</span>
	);
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** The clock above the bars, with its folded quiet stretches, and as many labels as its width has room for. */
function AxisRow({ axis, timeline }: { axis: Axis; timeline: boolean }) {
	const [clockRef, width] = useWidth<HTMLSpanElement>();
	const ticks = width ? ticksThatFit(axis, width) : axis.ticks;
	return (
		<div className={cn(LINE, "py-0")} aria-hidden="true">
			<span className={cn(chipBox(timeline), "invisible")} />
			<span className="-mx-0.5 size-5 flex-none" />
			<span className={MAIN}>
				<span className={cn(WORDS, !timeline && "to-640:hidden")} />
				<span
					ref={clockRef}
					className="relative min-h-4 flex-1 self-stretch font-mono text-[10px] leading-4 font-normal text-muted-foreground"
				>
					{axis.pieces
						.filter((piece) => piece.kind === "quiet")
						.map((piece) => (
							<span
								key={piece.from}
								className={cn("absolute top-0 bg-background text-center", GLIDES)}
								style={{ left: pct(piece.x0), width: pct(piece.x1 - piece.x0) }}
								title={quietWords(piece)}
							>
								⋯
							</span>
						))}
					{ticks.map((tick, index) => (
						<span
							key={index}
							className={cn("absolute -translate-x-1/2 whitespace-nowrap last:-translate-x-full", GLIDES)}
							style={{ left: pct(tick.x) }}
						>
							{tick.label}
						</span>
					))}
				</span>
			</span>
		</div>
	);
}

interface GoalRowProps {
	repo: string;
	branch: string;
	goal: Goal;
	/** Its title as the list shows it (see distinctTitles). */
	title: string;
	axis: Axis;
	timeline: boolean;
	/** Left out by the filter or the range: folded away, not gone. */
	hidden: boolean;
	open: boolean;
	onToggle(): void;
	lit: boolean;
	motion: (GoalMotion & { seq: number }) | undefined;
	/** Only just drawn, with no motion of its own: it fades in. */
	appearing: boolean;
	unseen: boolean;
	onHover(hovering: boolean): void;
	onAgent(agent: string): void;
	now: number;
}

function GoalRow({
	repo,
	branch,
	goal,
	title,
	axis,
	timeline,
	hidden,
	open,
	onToggle,
	lit,
	motion,
	appearing,
	unseen,
	onHover,
	onAgent,
	now,
}: GoalRowProps) {
	const status = goalStatus(goal);
	const bar = goalBar(goal, axis);
	// The steps stay drawn while they fold shut, and go once they have.
	const [drawn, setDrawn] = useState(open);
	useEffect(() => {
		if (open) setDrawn(true);
	}, [open]);
	// Its edge: red while it needs a person, darker open, lighter pointed at.
	const edge = hidden
		? "border-0 border-transparent"
		: cn(
				"border",
				goal.state === "needs-person"
					? cn(RED_EDGE, "hover:border-border")
					: open
						? "border-border-strong hover:border-border"
						: lit
							? "border-border"
							: "border-transparent hover:border-border",
			);
	const style = motion ? ({ "--motion-delay": `${motion.delay}ms` } as CSSProperties) : undefined;
	const steps = `steps-${goal.key}`;
	const meta = `${status.words} · ${goal.agent} · ${whenWords(goal, now)}${goal.paths.length ? ` · ${briefPaths(goal.paths, 1)}` : ""}`;
	return (
		<li
			className={cn(
				ROW,
				"group/goal",
				hidden ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
				edge,
				!hidden && (open || lit ? "bg-card" : "hover:bg-card"),
				motion ? ROW_MOTION[motion.motion] : appearing && "animate-hive-fade-in",
			)}
			style={style}
			data-key={goal.key}
			data-state={goal.state}
			inert={hidden}
			onMouseEnter={() => onHover(true)}
			onMouseLeave={() => onHover(false)}
			onFocus={() => onHover(true)}
			onBlur={() => onHover(false)}
		>
			<div className="min-h-0 overflow-hidden">
				<div className={cn(LINE, "py-(--row-pad) [transition:padding_0.45s_ease]")}>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								className={cn(
									chipBox(timeline, goal.agent),
									"touch-target inline-flex cursor-pointer items-center justify-center gap-1.5 [font-family:inherit] whitespace-nowrap no-underline",
								)}
								aria-label={`${agentChip(goal.agent)}: only ${goal.agent}'s goals`}
								onClick={() => onAgent(goal.agent)}
							>
								{agentChip(goal.agent)}
							</button>
						</TooltipTrigger>
						<TooltipContent>Only {goal.agent}'s goals</TooltipContent>
					</Tooltip>
					{/* The chevron alone opens and closes the row; the title goes to the change. */}
					<button
						type="button"
						className="group/chevron touch-target -mx-0.5 inline-grid size-5 flex-none cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-0 hover:bg-surface-3"
						aria-expanded={open}
						aria-controls={steps}
						aria-label={`Steps of ${goal.title}`}
						onClick={onToggle}
					>
						<Chevron open={open} />
					</button>
					<span className={cn(MAIN, !timeline && MAIN_STORY)}>
						<span className={cn(WORDS, goal.finished && "opacity-75")}>
							<span className="flex items-start gap-1.5">
								<Tooltip>
									<TooltipTrigger asChild>
										<a
											className={cn(titleClass(timeline), "min-w-0 text-foreground hover:text-link")}
											href={href.change(repo, goal.change)}
										>
											{title}
										</a>
									</TooltipTrigger>
									{/* Its title in full, and the second line that Timeline folds away and a narrow row cuts. */}
									<TooltipContent side="top" align="start" className="max-w-96 text-left">
										<span className="block font-semibold">{goal.title}</span>
										{meta}
									</TooltipContent>
								</Tooltip>
								{unseen ? <UnseenDot /> : null}
							</span>
							<span className={metaClass(timeline)}>
								<span className={TONE_CLASS[status.tone]}>{status.words}</span> · {goal.agent} · {whenWords(goal, now)}
								{goal.paths.length ? ` · ${briefPaths(goal.paths, 1)}` : ""}
							</span>
						</span>
						<span
							className={cn(
								TRACK,
								!timeline && "to-640:min-h-3 to-640:basis-full",
								timeline && goal.finished && "opacity-75",
							)}
							aria-hidden="true"
						>
							<BarView
								bar={bar}
								axis={axis}
								timeline={timeline}
								landing={goal.state === "landing"}
								motion={motion?.motion}
								now={now}
							/>
						</span>
					</span>
				</div>
				{open || drawn ? (
					// A row's steps slide open, and fold shut before they go.
					<div
						id={steps}
						className={cn(FOLD, "grid-rows-[1fr]", open ? "animate-goal-drawer-open" : "animate-goal-drawer-close")}
						inert={!open}
						onAnimationEnd={(event) => {
							if (!open && event.target === event.currentTarget) setDrawn(false);
						}}
					>
						<div>
							<GoalSteps repo={repo} branch={branch} goal={goal} open={open} now={now} />
						</div>
					</div>
				) : null}
			</div>
		</li>
	);
}

/** A row that changed while the tab was hidden: a dot, in words for whoever can't see it, and in a tooltip. */
function UnseenDot() {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					tabIndex={0}
					aria-label="Changed while you were away"
					className="mt-1.5 inline-block size-[7px] flex-none rounded-full bg-link"
				/>
			</TooltipTrigger>
			<TooltipContent>Changed while you were away</TooltipContent>
		</Tooltip>
	);
}

/** A goal's title: up to two lines in Story, one in Timeline, where it's smaller. */
const titleClass = (timeline: boolean) =>
	cn(
		"block no-underline [transition:font-size_0.45s_ease]",
		timeline ? "truncate text-meta font-medium" : "line-clamp-2 text-body-sm font-semibold",
	);

/** Its second line: where it stands, whose, how long. Timeline folds it away. */
const metaClass = (timeline: boolean) =>
	cn(
		"block truncate text-caption text-muted-foreground [transition:max-height_0.45s_ease,opacity_0.3s_ease]",
		timeline ? "max-h-0 opacity-0" : "max-h-5",
	);

/** The bar's room, with now drawn at its right edge. */
const TRACK =
	"relative min-h-4.5 flex-1 self-stretch after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-link/55";

/** The row's disclosure mark: points at the title shut, down at the steps open, and turns as it does. */
function Chevron({ open = false }: { open?: boolean }) {
	return (
		<svg
			className={cn(
				"size-2.5 flex-none [transition:rotate_0.25s_ease,color_0.2s_ease]",
				open ? "rotate-90 text-foreground" : "text-muted-foreground",
				"group-hover/chevron:text-link group-focus-visible/chevron:text-link",
			)}
			viewBox="0 0 10 10"
			width="10"
			height="10"
			aria-hidden="true"
		>
			<path
				d="M3.5 1.5 7 5l-3.5 3.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** How long it's been going, or when it finished and how long it took. */
function whenWords(goal: Goal, now: number): string {
	const announced = timeOf(goal.announced) ?? now;
	if (!goal.finished) return durationWords(now - announced);
	const took = (timeOf(goal.finished) ?? now) - announced;
	return `${timeAgo(goal.finished, now)}${goal.earlierSteps ? "" : `, took ${durationWords(took)}`}`;
}

// The bar, on the shared clock: building solid, in review dashed, landing amber; marks for the steps.

const PHASE: Record<BarPhase["kind"], string> = {
	building: "bg-stage-building/60",
	review:
		"bg-[repeating-linear-gradient(90deg,color-mix(in_srgb,var(--stage-review)_60%,transparent)_0_4px,transparent_4px_7px)]",
	landing: "bg-stage-landing",
	dropped: "bg-muted-foreground/35",
};

/** A stretch of the bar; the end of one being checked to land blinks. */
const phaseClass = (kind: BarPhase["kind"], blinks = false) =>
	cn("absolute top-1/2 -mt-[5px] h-2.5", GLIDES, PHASE[kind], blinks && "animate-goal-blink");

/**
 * A step's mark: a vote or a failure is a tick in its color, a question for a person a red dot, what agents hear
 * about each other an amber diamond. Quiet steps (pushes, asking to land) are hairlines, shown in Timeline only.
 */
function markClass(kind: BarMark["kind"], loud: boolean, timeline: boolean, pops = false): string {
	const shape = !loud
		? cn("-mt-1.5 -ml-px h-3 w-px rounded-[1px] bg-muted-foreground", !timeline && "opacity-0")
		: kind === "heads-up" || kind === "interface"
			? "-mt-[3.5px] -ml-[3.5px] size-[7px] rotate-45 rounded-[1px] bg-amber"
			: kind === "asked"
				? "-mt-[3px] -ml-[3px] size-[7px] rounded-full bg-bad"
				: cn("-mt-2 -ml-px h-4 w-[3px] rounded-[1px]", kind === "approved" ? "bg-good" : "bg-bad");
	return cn("absolute top-1/2", GLIDES, shape, pops && "animate-goal-pop");
}

/** How a goal ended, at the bar's end: ✓ landed, × released. */
const endClass = (kind: "landed" | "released", pops = false) =>
	cn(
		"absolute top-1/2 -mt-[7.5px] -ml-[7.5px] grid size-[15px] place-items-center rounded-full text-[9px] font-extrabold",
		GLIDES,
		kind === "landed"
			? "bg-good text-background"
			: "border-[1.5px] border-muted-foreground bg-background text-muted-foreground",
		pops && "animate-goal-pop",
	);

/** Of what happened, what pops on the bar: a vote's or a push's mark, when it's the bar's last; its end. */
const POPS: Motion[] = ["approved", "changes-asked", "pushed"];

function BarView({
	bar,
	axis,
	timeline,
	landing,
	motion,
	now,
}: {
	bar: Bar;
	axis: Axis;
	timeline: boolean;
	/** Its goal is being checked to land. */
	landing: boolean;
	motion: Motion | undefined;
	now: number;
}) {
	// Only what comes last on the bar blinks or pops: a landing stretch with no marks after it, a mark with no end.
	const lastPhase = !bar.end && !bar.marks.length ? bar.phases.length - 1 : -1;
	const lastMark = !bar.end ? bar.marks.length - 1 : -1;
	return (
		<>
			{axis.pieces
				.filter((piece) => piece.kind === "quiet")
				.map((piece) => (
					<span
						key={piece.from}
						className={cn(
							"absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_5px)] opacity-60",
							GLIDES,
						)}
						style={{ left: pct(piece.x0), width: pct(piece.x1 - piece.x0) }}
					/>
				))}
			{bar.clipped ? (
				<span
					className="absolute top-1/2 left-0 -mt-[5px] size-0 -translate-x-[10px] border-[5px] border-transparent border-r-muted-foreground"
					title={bar.clipped}
				/>
			) : null}
			{bar.phases.map((phase, index) => (
				<span
					key={index}
					className={phaseClass(phase.kind, landing && phase.kind === "landing" && index === lastPhase)}
					style={{ left: pct(phase.x0), width: pct(phase.x1 - phase.x0) }}
				/>
			))}
			{bar.marks.map((mark, index) => (
				<span
					key={index}
					className={markClass(
						mark.kind,
						mark.loud,
						timeline,
						index === lastMark && mark.kind === motion && POPS.includes(motion),
					)}
					style={{ left: pct(mark.x) }}
					title={`${clockTime(mark.at, now)} · ${stepLead({ kind: mark.kind, at: mark.at, ...(mark.by ? { by: mark.by } : {}) }, "")}`}
				/>
			))}
			{bar.end ? (
				<span
					className={endClass(bar.end.kind, motion === "landed" || motion === "released")}
					style={{ left: pct(bar.end.x) }}
				>
					{bar.end.kind === "landed" ? "✓" : "×"}
				</span>
			) : null}
		</>
	);
}

/** What a step says, before its evidence or reason. */
export function stepLead(step: GoalStep, branch: string): string {
	const who = displayName(step.by) ?? "an agent";
	const onto = branch ? ` on ${branch}` : "";
	switch (step.kind) {
		case "claimed":
			return `${who} claimed it`;
		case "widened":
			return `${who} widened its claim`;
		case "pushed":
			return step.commit ? `pushed ${shortSha(step.commit)}` : "pushed";
		case "approved":
			return `${who} approved${step.role && step.role !== "code" ? ` as ${step.role}` : ""}`;
		case "changes-asked":
			return step.role === "checks" ? "its checks failed" : `${who} asked for changes`;
		case "asked":
			return `${who} asked a person`;
		case "merging":
			return `${who} asked to land it`;
		case "checking":
			return `being checked to land${onto}, with the next batch`;
		case "failed":
			return "its checks failed while landing";
		case "landed":
			return `landed${onto}`;
		case "released":
			return `${who} released it`;
		case "heads-up":
			return step.side === "uses"
				? `heads-up: ${who}'s change alters something this one uses`
				: `heads-up: ${displayName(step.other) ?? "another agent"}'s change uses something this one alters`;
		case "interface":
			// The interface event's agent landed the change; the goal is the other side's, which uses it.
			return `${who} landed a change to something it uses`;
		case "conflicted":
			return "its merge conflicted";
	}
}

const QUOTED: GoalStep["kind"][] = ["approved", "changes-asked", "asked"];

/** A step's words, red where it was turned back or a person asked, green where it went ahead. */
const STEP_TONE: Partial<Record<GoalStep["kind"], string>> = {
	"changes-asked": "text-bad",
	failed: "text-bad",
	asked: "text-bad",
	approved: "text-good",
	landed: "text-good",
};

/** Where an opened row's line comes in the cascade of them; past a dozen they come in together. */
const stagger = (index: number) => ({ "--i": Math.min(index, 12) }) as CSSProperties;

const STEP = "grid grid-cols-[46px_1fr] gap-2 py-0.5";

/** A goal's steps, opened in place: its intent in full, each step with its time, evidence and reasons. */
function GoalSteps({
	repo,
	branch,
	goal,
	open,
	now,
}: {
	repo: string;
	branch: string;
	goal: Goal;
	/** Open, each line arrives just after the one above it; folding shut, they stay. */
	open: boolean;
	now: number;
}) {
	// Only a change that needs a person (status.ts, waitingOn) asks for one here: its agent's question to answer, or a
	// vote only people may give. One still building, or waiting on its reviewers, is the agents' to move.
	const waiting = goal.state === "needs-person";
	const intent = goal.intent.trim();
	const arrives = open && "animate-goal-step-in";
	return (
		<div className="mt-0 mr-2.5 mb-2 ml-10 border-l border-border-strong py-0.5 pr-0 pl-3 text-ui">
			{intent && intent !== goal.title ? (
				<p className={cn("mx-0 mt-1 mb-2 whitespace-pre-wrap text-muted-foreground", arrives)} style={stagger(0)}>
					{intent}
				</p>
			) : null}
			<ol className="m-0 list-none p-0">
				{goal.earlierSteps ? (
					<li className={cn(STEP, arrives)}>
						<span />
						<span className="text-muted-foreground">Earlier steps aren't kept here; the change has them all.</span>
					</li>
				) : null}
				{goal.steps.map((step, index) => (
					<li key={index} className={cn(STEP, arrives)} style={stagger(index + 1)}>
						<time dateTime={step.at} className="font-mono text-micro leading-5 font-normal text-muted-foreground">
							{clockTime(step.at, now)}
						</time>
						<span className={STEP_TONE[step.kind]}>
							{stepLead(step, branch)}
							{step.text && step.kind !== "claimed" ? (
								QUOTED.includes(step.kind) ? (
									<>
										: <q className="text-muted-foreground italic">{step.text}</q>
									</>
								) : (
									<span className="text-muted-foreground">: {step.text}</span>
								)
							) : null}
						</span>
					</li>
				))}
			</ol>
			<p className={cn("mx-0 mt-1.5 mb-0.5 text-caption", arrives)} style={stagger(goal.steps.length + 1)}>
				<a href={href.change(repo, goal.change, "conversation", { decide: !!waiting })}>
					{!waiting ? "Open the change →" : goal.attention ? "Answer it on its page →" : "Vote on its page →"}
				</a>
			</p>
		</div>
	);
}
