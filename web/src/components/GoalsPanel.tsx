import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { displayName } from "../lib/agent";
import { type Goal, type GoalStep, goalStatus } from "../lib/goals";
import { agentChip } from "../lib/hiveCells";
import type { GoalMotion } from "../lib/hiveMotion";
import { briefPaths, shortSha, timeOf } from "../lib/model";
import { counted } from "../lib/plural";
import { clockTime, timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { durationWords } from "../lib/stretch";
import { type Axis, type Bar, goalBar, quietWords, RANGE_WORDS, RANGES, timeAxis } from "../lib/timeAxis";
import type { HiveFilter } from "./HiveTab";
import "./GoalsPanel.css";

// The goals panel: one row per goal, in flight on top (newest arrival first), finished below. Story reads in words,
// with a slim bar on the shared clock; Timeline is the same rows, morphed, the bars taking the room. Rows never jump:
// a new goal comes in at the top, a landed one stays a minute before it moves down to Finished.

type View = "story" | "timeline";

/** How long a finished goal stays among those in flight, so it doesn't vanish from under the reader. */
export const SETTLE_MS = 60_000;
/** Longer, while the pointer is on it. */
const HELD_MS = 5 * 60_000;

const VIEW_KEY = "githive.hive.view";

const TONE_CLASS = {
	accent: "tone-accent",
	amber: "tone-warn",
	good: "tone-good",
	bad: "tone-bad",
	muted: "muted",
} as const;

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
	/** The view to start in, where there's no remembered one (tests). */
	view?: View;
}

export function GoalsPanel(props: GoalsPanelProps) {
	const { repo, branch, goals, range, filter, now } = props;
	const [view, setView] = useView(props.view);
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [showFinished, setShowFinished] = useState(false);
	const [held, setHeld] = useState<string | null>(null);
	const panel = useRef<HTMLElement>(null);
	const axis = timeAxis(goals, range, now);
	const finishedAt = (goal: Goal) => timeOf(goal.finished) ?? 0;
	const settling = (goal: Goal) =>
		!!goal.finished && (now - finishedAt(goal) < SETTLE_MS || (held === goal.key && now - finishedAt(goal) < HELD_MS));
	// Every goal keeps its row. One the filter or the range leaves out folds away rather than vanishing, so nothing
	// appears or disappears at once.
	const inFlight = goals.filter((goal) => !goal.finished || settling(goal));
	const done = goals.filter((goal) => goal.finished && !settling(goal)).sort((a, b) => finishedAt(b) - finishedAt(a));
	const inRange = (goal: Goal) => finishedAt(goal) >= axis.start;
	const flying = inFlight.filter((goal) => matches(goal, filter));
	const landed = done.filter((goal) => matches(goal, filter) && inRange(goal));
	const earlier = done.filter((goal) => matches(goal, filter) && !inRange(goal)).length;
	const working = flying.filter((goal) => !goal.finished).length;
	// No goal at all yet: a sample of what one will look like, instead of an empty clock ticking along.
	const empty = !goals.length;
	const sample = useLingering(empty, 500);
	useGlide(panel, `${inFlight.map((goal) => goal.key).join(" ")} | ${done.map((goal) => goal.key).join(" ")}`);
	const toggle = (key: string) => {
		props.onSeen(key);
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
			axis={axis}
			hidden={!shows}
			open={open.has(goal.key)}
			onToggle={() => toggle(goal.key)}
			lit={props.lit.has(goal.key)}
			motion={props.motions.get(goal.key)}
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
			className={`goals goals--${view}${showFinished ? " goals--finished-open" : ""}`}
			aria-labelledby="goals-title"
		>
			<div className="goals__head">
				<h2 id="goals-title">Goals</h2>
				<span className="muted">{working ? `${working} in flight` : "nothing in flight"}</span>
				{filter ? (
					<button type="button" className="goals__filter" onClick={() => props.onFilter(null)} title="Show every goal">
						{filter.kind === "agent" ? `only ${filter.agent}` : `only ${filter.label}`}{" "}
						<span aria-hidden="true">×</span>
					</button>
				) : null}
				<div className={`goals__controls${empty ? " goals__controls--off" : ""}`} inert={empty}>
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
				<p className="muted goals__note">The event log couldn't be read ({props.error}), so steps may be missing.</p>
			) : null}
			<div className={`goals__swap goals__empty${empty ? " goals__swap--open" : ""}`} inert={!empty}>
				<div>{sample ? <EmptyGoals /> : null}</div>
			</div>
			<div className={`goals__swap${empty ? "" : " goals__swap--open"}`} inert={empty}>
				<div>
					<AxisRow axis={axis} />
					<div className="goals__section">
						<span>In flight · {working}</span>
					</div>
					<ol className="goals__rows">{inFlight.map((goal) => row(goal, matches(goal, filter)))}</ol>
					{flying.length ? null : (
						<p className="muted goals__note">
							{filter ? "Nothing in flight here." : "Nothing in flight now."}
							{filter ? (
								<>
									{" "}
									<button type="button" className="link-button" onClick={() => props.onFilter(null)}>
										Show every goal
									</button>
								</>
							) : null}
						</p>
					)}
					{done.length ? (
						<div className={`goals__done${landed.length ? "" : " goals__done--empty"}`} inert={!landed.length}>
							<div>
								<div className="goals__section">
									<span>Finished · {landed.length}</span>
									<button type="button" className="link-button goals__fold" onClick={() => setShowFinished(false)}>
										fold
									</button>
								</div>
								<div className="goals__summary-wrap">
									<div>
										<button
											type="button"
											className="goals__summary"
											onClick={() => setShowFinished(true)}
											aria-expanded={showFinished}
										>
											<FinishedWords goals={landed} />
											<span className="goals__show">show</span>
										</button>
									</div>
								</div>
								<div className="goals__finished">
									<ol className="goals__rows">
										{done.map((goal) => row(goal, matches(goal, filter) && inRange(goal)))}
									</ol>
								</div>
							</div>
						</div>
					) : null}
					{earlier ? (
						<p className="muted goals__note">
							{counted(earlier, "goal")} finished before the range. <a href={href.repo(repo, "history")}>See History</a>
						</p>
					) : null}
				</div>
			</div>
		</section>
	);
}

/** True while `on` is, and for `ms` after, so what it shows can fold away before it goes. */
function useLingering(on: boolean, ms: number): boolean {
	const [lingering, setLingering] = useState(on);
	useEffect(() => {
		if (on) {
			setLingering(true);
			return;
		}
		const timer = setTimeout(() => setLingering(false), ms);
		return () => clearTimeout(timer);
	}, [on, ms]);
	return on || lingering;
}

/** Before any goal: a faint sample row, saying what each one will show and where agents come from. */
function EmptyGoals() {
	return (
		<div className="goals__sample">
			<div className="goal goal--sample" aria-hidden="true">
				<div className="goal__body">
					<div className="goal__line">
						<span className="goal__chip">?</span>
						<span className="goal__main">
							<Chevron />
							<span className="goal__words">
								<span className="goal__title">What an agent sets out to do</span>
								<span className="goal__meta">where it stands · which agent · how long it took</span>
							</span>
							<span className="goal__track">
								<span className="bar__phase bar__phase--building" style={{ left: "38%", width: "24%" }} />
								<span className="bar__phase bar__phase--review" style={{ left: "62%", width: "16%" }} />
								<span className="bar__mark bar__mark--approved bar__mark--loud" style={{ left: "78%" }} />
								<span className="bar__phase bar__phase--landing" style={{ left: "78%", width: "8%" }} />
								<span className="bar__end bar__end--landed" style={{ left: "86%" }}>
									✓
								</span>
							</span>
						</span>
					</div>
				</div>
			</div>
			<p className="muted goals__note">
				No goals yet. Each change an agent claims here becomes a row: what it set out to do, where it stands, and what
				became of it. <a href={href.agents()}>Connect an agent</a>
			</p>
		</div>
	);
}

/**
 * Rows glide to where they now are when the list changes shape (a goal arrives, or one moves down to Finished)
 * instead of jumping. Positions are measured within the panel, so scrolling moves nothing; and a change that only
 * resizes rows (opening one, switching views) is left to the rows' own transitions.
 */
function useGlide(panel: RefObject<HTMLElement | null>, shape: string) {
	const last = useRef<{ shape: string; tops: Map<string, number> }>({ shape, tops: new Map() });
	useLayoutEffect(() => {
		const element = panel.current;
		if (!element) return;
		const origin = element.getBoundingClientRect().top;
		const rows = [...element.querySelectorAll<HTMLElement>("li.goal[data-key]")];
		const tops = new Map(rows.map((row) => [row.dataset.key ?? "", row.getBoundingClientRect().top - origin]));
		const before = last.current;
		last.current = { shape, tops };
		if (before.shape === shape || !before.tops.size) return;
		if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		for (const row of rows) {
			const was = before.tops.get(row.dataset.key ?? "");
			const is = tops.get(row.dataset.key ?? "");
			if (was === undefined || is === undefined || Math.abs(was - is) < 2) continue;
			row.animate([{ transform: `translateY(${was - is}px)` }, { transform: "none" }], {
				duration: 380,
				easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
			});
		}
	});
}

function matches(goal: Goal, filter: HiveFilter | null): boolean {
	if (!filter) return true;
	if (filter.kind === "agent") return goal.agent === filter.agent;
	return filter.goals.includes(goal.key);
}

/** Story or Timeline, remembered in this browser. */
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

function Segmented<T extends string | number>({
	label,
	options,
	value,
	onPick,
}: {
	label: string;
	options: { value: T; words: string }[];
	value: T;
	onPick(value: T): void;
}) {
	return (
		<div className="segmented" role="group" aria-label={label}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={option.value === value}
					className={option.value === value ? "segmented__on" : undefined}
					onClick={() => onPick(option.value)}
				>
					{option.words}
				</button>
			))}
		</div>
	);
}

/** "✓ 2 landed · 1 dropped", and the first few titles. */
function FinishedWords({ goals }: { goals: Goal[] }) {
	const landed = goals.filter((goal) => goal.state === "landed").length;
	const dropped = goals.length - landed;
	const titles = goals.slice(0, 3).map((goal) => goal.title);
	const more = goals.length - titles.length;
	return (
		<span className="goals__summary-words">
			{landed ? <b className="tone-good">✓ {landed} landed</b> : null}
			{landed && dropped ? " · " : null}
			{dropped ? <b>{dropped} dropped</b> : null}
			<span className="muted">
				{" "}
				{titles.join(", ")}
				{more ? `, and ${more} more` : ""}
			</span>
		</span>
	);
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** The clock above the bars, with its folded quiet stretches. */
function AxisRow({ axis }: { axis: Axis }) {
	return (
		<div className="goal__line goals__axis" aria-hidden="true">
			<span className="goal__chip goal__chip--space" />
			<span className="goal__main">
				<span className="goal__chevron goal__chevron--space" />
				<span className="goal__words" />
				<span className="goal__track goals__clock">
					{axis.pieces
						.filter((piece) => piece.kind === "quiet")
						.map((piece) => (
							<span
								key={piece.from}
								className="goals__quiet"
								style={{ left: pct(piece.x0), width: pct(piece.x1 - piece.x0) }}
								title={quietWords(piece)}
							>
								⋯
							</span>
						))}
					{axis.ticks.map((tick, index) => (
						<span key={index} className="goals__tick" style={{ left: pct(tick.x) }}>
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
	axis: Axis;
	/** Left out by the filter or the range: folded away, not gone. */
	hidden: boolean;
	open: boolean;
	onToggle(): void;
	lit: boolean;
	motion: (GoalMotion & { seq: number }) | undefined;
	unseen: boolean;
	onHover(hovering: boolean): void;
	onAgent(agent: string): void;
	now: number;
}

function GoalRow({
	repo,
	branch,
	goal,
	axis,
	hidden,
	open,
	onToggle,
	lit,
	motion,
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
	const className = [
		"goal",
		`goal--${goal.state}`,
		open ? "goal--open" : "",
		hidden ? "goal--hidden" : "",
		lit ? "goal--lit" : "",
		goal.finished ? "goal--done" : "",
		motion ? `goal--m-${motion.motion}` : "",
	]
		.filter(Boolean)
		.join(" ");
	const style = motion ? ({ "--motion-delay": `${motion.delay}ms` } as CSSProperties) : undefined;
	return (
		<li
			className={className}
			style={style}
			data-key={goal.key}
			inert={hidden}
			onMouseEnter={() => onHover(true)}
			onMouseLeave={() => onHover(false)}
		>
			<div className="goal__body">
				<div className="goal__line">
					<button
						type="button"
						className="goal__chip"
						title={`Only ${goal.agent}'s goals`}
						onClick={() => onAgent(goal.agent)}
					>
						{agentChip(goal.agent)}
					</button>
					<button
						type="button"
						className="goal__main"
						aria-expanded={open}
						onClick={onToggle}
						onFocus={() => onHover(true)}
						onBlur={() => onHover(false)}
						title={goal.intent || goal.title}
					>
						<Chevron />
						<span className="goal__words">
							<span className="goal__title">
								{goal.title}
								{unseen ? <span className="goal__unseen" title="Changed while you were away" /> : null}
							</span>
							<span className="goal__meta">
								<span className={TONE_CLASS[status.tone]}>{status.words}</span> · {goal.agent} · {whenWords(goal, now)}
								{goal.paths.length ? ` · ${briefPaths(goal.paths, 1)}` : ""}
							</span>
						</span>
						<span className="goal__track" aria-hidden="true">
							<BarView bar={bar} axis={axis} now={now} />
						</span>
					</button>
				</div>
				{open || drawn ? (
					<div
						className={`goal__drawer${open ? "" : " goal__drawer--closing"}`}
						inert={!open}
						onAnimationEnd={(event) => {
							if (!open && event.target === event.currentTarget) setDrawn(false);
						}}
					>
						<div>
							<GoalSteps repo={repo} branch={branch} goal={goal} now={now} />
						</div>
					</div>
				) : null}
			</div>
		</li>
	);
}

/** The row's disclosure mark: points at the title shut, down at the steps open. */
function Chevron() {
	return (
		<svg className="goal__chevron" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
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

function BarView({ bar, axis, now }: { bar: Bar; axis: Axis; now: number }) {
	return (
		<>
			{axis.pieces
				.filter((piece) => piece.kind === "quiet")
				.map((piece) => (
					<span
						key={piece.from}
						className="bar__quiet"
						style={{ left: pct(piece.x0), width: pct(piece.x1 - piece.x0) }}
					/>
				))}
			{bar.clipped ? <span className="bar__clipped" title={bar.clipped} /> : null}
			{bar.phases.map((phase, index) => (
				<span
					key={index}
					className={`bar__phase bar__phase--${phase.kind}`}
					style={{ left: pct(phase.x0), width: pct(phase.x1 - phase.x0) }}
				/>
			))}
			{bar.marks.map((mark, index) => (
				<span
					key={index}
					className={`bar__mark bar__mark--${mark.kind} bar__mark--${mark.loud ? "loud" : "quiet"}`}
					style={{ left: pct(mark.x) }}
					title={`${clockTime(mark.at, now)} · ${stepLead({ kind: mark.kind, at: mark.at, ...(mark.by ? { by: mark.by } : {}) }, "")}`}
				/>
			))}
			{bar.end ? (
				<span className={`bar__end bar__end--${bar.end.kind}`} style={{ left: pct(bar.end.x) }}>
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

/** Where an opened row's line comes in the cascade of them; past a dozen they come in together. */
const stagger = (index: number) => ({ "--i": Math.min(index, 12) }) as CSSProperties;

/** A goal's steps, opened in place: its intent in full, each step with its time, evidence and reasons. */
function GoalSteps({ repo, branch, goal, now }: { repo: string; branch: string; goal: Goal; now: number }) {
	const waiting = goal.state === "asking" || (goal.approval?.awaiting?.length ?? 0) > 0;
	const intent = goal.intent.trim();
	return (
		<div className="goal__steps">
			{intent && intent !== goal.title ? (
				<p className="goal__intent" style={stagger(0)}>
					{intent}
				</p>
			) : null}
			<ol>
				{goal.earlierSteps ? (
					<li className="goal__step goal__step--earlier">
						<span />
						<span className="muted">Earlier steps aren't kept here; the change has them all.</span>
					</li>
				) : null}
				{goal.steps.map((step, index) => (
					<li key={index} className={`goal__step goal__step--${step.kind}`} style={stagger(index + 1)}>
						<time dateTime={step.at}>{clockTime(step.at, now)}</time>
						<span>
							{stepLead(step, branch)}
							{step.text && step.kind !== "claimed" ? (
								QUOTED.includes(step.kind) ? (
									<>
										: <q className="goal__evidence">{step.text}</q>
									</>
								) : (
									<span className="muted">: {step.text}</span>
								)
							) : null}
						</span>
					</li>
				))}
			</ol>
			<p className="goal__links" style={stagger(goal.steps.length + 1)}>
				<a href={href.change(repo, goal.change)}>{waiting ? "Answer it on its page →" : "Open the change →"}</a>
			</p>
		</div>
	);
}
