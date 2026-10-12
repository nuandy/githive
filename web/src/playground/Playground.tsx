import { useEffect, useRef, useState } from "react";
import { Hive } from "../components/HiveTab";
import { NarrowFrame } from "./NarrowFrame";
import { createSim, SCENARIOS, type ScenarioName, type Sim, type SimState } from "./sim";
import "../App.css";
import "./playground.css";

// The Hive playground: the real Hive tab, drawn from a simulated hive on a virtual clock, with a slim bar to play,
// pause, speed up, step, reset, switch scenario or seed, answer what waits on a person, and see the Hive in a window
// 720 px wide.
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
	// The Hive as the repo page draws it: in the page's main column, with the landing and the feed shown.
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
		/>
	) : null;

	return (
		<div ref={page} className={`shell playground playground--${width}`}>
			<div ref={bar} className="playground__bar" role="toolbar" aria-label="Playground">
				<div className="playground__row">
					<strong className="playground__name">Hive playground</strong>
					<label className="playground__field" title={description}>
						<span className="sr-only">Scenario</span>
						<select value={scenario} onChange={(event) => update({ scenario: event.target.value as ScenarioName })}>
							{SCENARIOS.map((each) => (
								<option key={each.name} value={each.name}>
									{each.title}
								</option>
							))}
						</select>
					</label>
					<label className="playground__field">
						<span className="muted">seed</span>
						<input
							type="number"
							className="playground__seed"
							value={seed}
							onChange={(event) => {
								const next = Number.parseInt(event.target.value, 10);
								if (Number.isFinite(next)) update({ seed: next });
							}}
						/>
					</label>
					<span className="playground__group">
						<button type="button" onClick={() => setPlaying((was) => !was)} aria-pressed={playing}>
							{playing ? "Pause" : "Play"}
						</button>
						<span className="playground__segments" role="group" aria-label="Speed">
							{SPEEDS.map((each) => (
								<button key={each} type="button" aria-pressed={speed === each} onClick={() => update({ speed: each })}>
									{each}×
								</button>
							))}
						</span>
					</span>
					<span className="playground__group">
						<button
							type="button"
							onClick={() => act((current) => current.step())}
							disabled={view?.next == null}
							title={view?.next != null ? `Jump to the next event, ${untilWords(view.next - now)} away` : undefined}
						>
							Step
						</button>
						<button type="button" onClick={() => act((current) => current.advance(10 * MINUTE))}>
							Skip 10 min
						</button>
						<button type="button" onClick={() => setRun((count) => count + 1)}>
							Reset
						</button>
					</span>
					<span className="playground__clock" title="The virtual clock">
						{clock(now)}
					</span>
					<span className="muted">
						{view?.events ?? 0} events
						{view?.done ? " · run over" : view?.next == null && view?.waiting.length ? " · waiting on a person" : ""}
					</span>
					<span className="playground__segments playground__width" role="group" aria-label="Width">
						{(["wide", "narrow"] as const).map((each) => (
							<button key={each} type="button" aria-pressed={width === each} onClick={() => update({ width: each })}>
								{each === "wide" ? "Wide" : "Narrow"}
							</button>
						))}
					</span>
				</div>
				{view?.waiting.length ? (
					<div className="playground__row playground__person">
						<span>A person is needed:</span>
						{view.waiting.map((change) => (
							<span key={change} className="playground__group">
								<button type="button" onClick={() => act((current) => current.personVotes(change, "approve"))}>
									Approve {change}
								</button>
								<button type="button" onClick={() => act((current) => current.personVotes(change, "reject"))}>
									Reject {change}
								</button>
							</span>
						))}
					</div>
				) : null}
			</div>
			{width === "narrow" ? (
				<div className="playground__narrow">
					<NarrowFrame width={NARROW_PX}>
						<main className="page">{hive}</main>
					</NarrowFrame>
				</div>
			) : (
				<main className="page" id="main">
					{hive}
				</main>
			)}
		</div>
	);
}
