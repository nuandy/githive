import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { Hive } from "../components/HiveTab";
import { Page, Shell } from "../components/Page";
import { ThemeMenu } from "../components/ThemeMenu";
import { Button } from "../components/ui/button";
import { Input, NativeSelect } from "../components/ui/field";
import { cn } from "../lib/utils";
import { NarrowFrame } from "./NarrowFrame";
import { createSim, SCENARIOS, type ScenarioName, type Sim, type SimState } from "./sim";

// The Hive playground: the real Hive tab, drawn from a simulated hive on a virtual clock, with a slim bar to play,
// pause, speed up, step, reset, switch scenario or seed, answer what waits on a person, see the Hive in a window
// 720 px wide, and switch between light and dark.
// The scenario, seed, speed and width live in the address, so a reload or a shared link plays the same run.

const SPEEDS = [1, 5, 20, 60];
/** How wide the narrow view's window is. */
const NARROW_PX = 720;
const TICK_MS = 250;
const MINUTE = 60_000;
/** How far into a run the page opens, in virtual minutes, so most hives are busy at once. */
const OPENS_AT: Record<ScenarioName, number> = {
	mixed: 6,
	swarm: 6,
	"big-repo": 6,
	"quiet-burst": 0,
	"first-agent": 0,
};

type Width = "wide" | "narrow";

interface Settings {
	scenario: ScenarioName;
	seed: number;
	speed: number;
	width: Width;
}

function readSettings(): Settings {
	const query = new URLSearchParams(window.location.search);
	const seed = Number.parseInt(query.get("seed") ?? "", 10);
	const speed = Number(query.get("speed"));
	return {
		scenario: SCENARIOS.find((each) => each.name === query.get("scenario"))?.name ?? "mixed",
		seed: Number.isFinite(seed) ? seed : 1,
		speed: SPEEDS.includes(speed) ? speed : 5,
		width: query.get("width") === "narrow" ? "narrow" : "wide",
	};
}

function writeSettings({ scenario, seed, speed, width }: Settings) {
	const query = new URLSearchParams({ scenario, seed: String(seed), speed: String(speed) });
	if (width === "narrow") query.set("width", width);
	window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
}

/** A new run, started early enough that once it has opened, its clock reads the real time. */
function startRun(scenario: ScenarioName, seed: number): Sim {
	const opensAt = OPENS_AT[scenario] * MINUTE;
	const sim = createSim(scenario, seed, Date.now() - opensAt);
	sim.advance(opensAt);
	return sim;
}

/** What the page draws from a run: its state, and what the bar says about it. */
interface View {
	state: SimState;
	waiting: string[];
	events: number;
	next: number | null;
	done: boolean;
}

const viewOf = (sim: Sim): View => ({
	state: sim.state(),
	waiting: sim.needsPerson(),
	events: sim.stats().events,
	next: sim.nextAt(),
	done: sim.done(),
});

const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
	const at = new Date(ms);
	return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
};

// The bar is small and quiet, so the Hive under it is what you look at: its controls are a size smaller than the
// dashboard's, and a pressed one is shaded.
const SMALL = "px-2 py-0.5 text-ui font-medium";
/** The same for a field, whose font and line height otherwise come from around it. */
const SMALL_FIELD = "px-2 py-0.5 text-ui [font-weight:500] [line-height:18px]";
const ROW = "mx-auto flex max-w-(--page-width) flex-wrap items-center gap-x-3.5 gap-y-1.5 px-6 py-[7px]";
const GROUP = "inline-flex items-center gap-1.5 font-normal";
/** A button answering for a person, edged in the needs color. */
const PERSON = "border-[color-mix(in_srgb,var(--needs)_45%,var(--border-strong))]";

/** One of the bar's buttons. */
function BarButton({ className, ...props }: ComponentProps<typeof Button>) {
	return (
		<Button
			className={cn(SMALL, "leading-[18px] aria-pressed:bg-surface-3 aria-pressed:text-foreground", className)}
			{...props}
		/>
	);
}

/** Buttons joined into one strip, the pressed one shaded: the speed, the width. */
function Segments({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
	return (
		<span
			className={cn(
				"inline-flex *:rounded-none *:first:rounded-l-md *:last:rounded-r-md *:not-first:-ml-px",
				className,
			)}
			role="group"
			aria-label={label}
		>
			{children}
		</span>
	);
}

/** How long until the next action, in words for the Step button's hint. */
function untilWords(ms: number) {
	const minutes = Math.round(ms / MINUTE);
	if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function Playground() {
	const [settings, setSettings] = useState(readSettings);
	const { scenario, seed, speed, width } = settings;
	const [playing, setPlaying] = useState(true);
	// Bumped by Reset, to start the same run again.
	const [run, setRun] = useState(0);
	const sim = useRef<Sim | null>(null);
	const [view, setView] = useState<View | null>(null);
	const page = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLDivElement>(null);

	useEffect(() => writeSettings(settings), [settings]);

	useEffect(() => {
		const started = startRun(scenario, seed);
		sim.current = started;
		setView(viewOf(started));
	}, [scenario, seed, run]);

	// Each tick moves the virtual clock by the real time since the last, times the speed, so a slow frame doesn't drift.
	useEffect(() => {
		if (!playing) return;
		let last = performance.now();
		const timer = window.setInterval(() => {
			const current = sim.current;
			if (!current) return;
			const now = performance.now();
			current.advance((now - last) * speed);
			last = now;
			setView(viewOf(current));
		}, TICK_MS);
		return () => window.clearInterval(timer);
	}, [playing, speed]);

	// What sticks under the app's top bar sticks under this one instead.
	useEffect(() => {
		const element = bar.current;
		if (!element) return;
		const observer = new ResizeObserver(() =>
			page.current?.style.setProperty("--topbar-height", `${element.offsetHeight}px`),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const act = (change: (current: Sim) => void) => {
		const current = sim.current;
		if (!current) return;
		change(current);
		setView(viewOf(current));
	};
	const update = (patch: Partial<Settings>) => setSettings((old) => ({ ...old, ...patch }));
	const description = SCENARIOS.find((each) => each.name === scenario)?.description;
	const now = view?.state.now ?? Date.now();
	// The Hive as the repo page draws it for someone who can write: in the page's main column, with the landing and the
	// feed shown.
	const hive = view ? (
		<Hive
			repo={view.state.snapshot.repo}
			branch="main"
			snapshot={view.state.snapshot}
			landing={view.state.landing}
			tree={view.state.tree}
			events={view.state.events}
			backlog={view.state.backlog}
			now={view.state.now}
			showsLanding
			showsFeed
			writes
			origin={window.location.origin}
		/>
	) : null;

	return (
		<Shell ref={page}>
			<div
				ref={bar}
				className="sticky top-0 z-10 border-b border-border bg-card text-ui text-muted-foreground"
				role="toolbar"
				aria-label="Playground"
			>
				<div className={ROW}>
					<strong className="font-bold text-foreground">Hive playground</strong>
					<label className={GROUP} title={description}>
						<span className="sr-only">Scenario</span>
						<NativeSelect
							className={SMALL_FIELD}
							value={scenario}
							onChange={(event) => update({ scenario: event.target.value as ScenarioName })}
						>
							{SCENARIOS.map((each) => (
								<option key={each.name} value={each.name}>
									{each.title}
								</option>
							))}
						</NativeSelect>
					</label>
					<label className={GROUP}>
						<span className="text-muted-foreground">seed</span>
						<Input
							type="number"
							className={cn(SMALL_FIELD, "w-16 font-mono")}
							value={seed}
							onChange={(event) => {
								const next = Number.parseInt(event.target.value, 10);
								if (Number.isFinite(next)) update({ seed: next });
							}}
						/>
					</label>
					<span className={GROUP}>
						<BarButton onClick={() => setPlaying((was) => !was)} aria-pressed={playing}>
							{playing ? "Pause" : "Play"}
						</BarButton>
						<Segments label="Speed">
							{SPEEDS.map((each) => (
								<BarButton key={each} aria-pressed={speed === each} onClick={() => update({ speed: each })}>
									{each}×
								</BarButton>
							))}
						</Segments>
					</span>
					<span className={GROUP}>
						<BarButton
							onClick={() => act((current) => current.step())}
							disabled={view?.next == null}
							title={view?.next != null ? `Jump to the next event, ${untilWords(view.next - now)} away` : undefined}
						>
							Step
						</BarButton>
						<BarButton onClick={() => act((current) => current.advance(10 * MINUTE))}>Skip 10 min</BarButton>
						<BarButton onClick={() => setRun((count) => count + 1)}>Reset</BarButton>
					</span>
					<span className="font-mono text-foreground" title="The virtual clock">
						{clock(now)}
					</span>
					<span className="text-muted-foreground">
						{view?.events ?? 0} events
						{view?.done ? " · run over" : view?.next == null && view?.waiting.length ? " · waiting on a person" : ""}
					</span>
					<Segments label="Width" className="ml-auto">
						{(["wide", "narrow"] as const).map((each) => (
							<BarButton key={each} aria-pressed={width === each} onClick={() => update({ width: each })}>
								{each === "wide" ? "Wide" : "Narrow"}
							</BarButton>
						))}
					</Segments>
					{/* As tall as the bar's row without its padding: the round button reaches into it rather than widen the bar. */}
					<span className="-my-[3px] inline-flex">
						<ThemeMenu />
					</span>
				</div>
				{view?.waiting.length ? (
					<div className={cn(ROW, "border-t border-border text-needs")}>
						<span>A person is needed:</span>
						{view.waiting.map((change) => (
							<span key={change} className={GROUP}>
								<BarButton className={PERSON} onClick={() => act((current) => current.personVotes(change, "approve"))}>
									Approve {change}
								</BarButton>
								<BarButton className={PERSON} onClick={() => act((current) => current.personVotes(change, "reject"))}>
									Reject {change}
								</BarButton>
							</span>
						))}
					</div>
				) : null}
			</div>
			{width === "narrow" ? (
				// The Hive in a window of its own, so its narrow layout shows.
				<div className="py-6">
					<NarrowFrame width={NARROW_PX}>
						<Page>{hive}</Page>
					</NarrowFrame>
				</div>
			) : (
				<Page>{hive}</Page>
			)}
		</Shell>
	);
}
