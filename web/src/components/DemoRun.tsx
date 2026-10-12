import { useEffect, useState } from "react";
import type { DemoRunStatus } from "../api";
import { usePoll } from "../hooks/usePoll";
import { messageOf } from "../lib/errors";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import "./DemoRun.css";

// Honeycomb demo runs on the dashboard: the card that starts one, and the banner on the demo repo's Hive tab that says
// how it's going. A run is GitHive's own agents building a small word game again, in GitHive's one public demo repo.

export interface DemoApi {
	start(): Promise<{ id: string; repo: string }>;
	runs(): Promise<{ running: { fullName: string } | null; newest?: DemoRunStatus | null }>;
}

/** Starts a demo run and opens its repo's Hive tab; or says a run is going, or why one can't start. */
export function DemoCard({ api }: { api: DemoApi }) {
	const runs = usePoll("demo:runs", () => api.runs(), 30_000);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const running = runs.data?.running;
	const newest = runs.data?.newest;
	const start = async () => {
		setBusy(true);
		setError(null);
		try {
			const made = await api.start();
			window.location.hash = href.repo(made.repo);
		} catch (err) {
			setError(messageOf(err));
			setBusy(false);
		}
	};
	return (
		<section className="box demo-card" aria-labelledby="demo-card-title">
			<div className="demo-card__body">
				<h2 id="demo-card-title">Watch a hive build Honeycomb (Demo Game)</h2>
				<p className="muted">
					Thirteen of GitHive's own agents build a small word game in GitHive's public demo repo, starting over from its
					first files. Nothing assigns the work: each takes a piece from the backlog, claims its files, builds it, gets
					it reviewed and tested, and lands it. It takes about 10 minutes, and you can play the game when it's done.
				</p>
				{error ? (
					<p className="error" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<div className="demo-card__action">
				{running ? (
					<a className="button" href={href.repo(running.fullName)}>
						Watch the run going now
					</a>
				) : (
					<button type="button" className="accent" onClick={start} disabled={busy}>
						{busy ? "Setting up the repo…" : "Start a demo run"}
					</button>
				)}
				{newest && gameLanded(newest) ? <PlayLink repo={newest.fullName} /> : null}
			</div>
		</section>
	);
}

/**
 * Whether a run built the whole game: it finished with every piece landed. While a run is going, or after one was
 * stopped, the repo holds part of a game, so there's nothing to play.
 */
export function gameLanded(run: Pick<DemoRunStatus, "status" | "agents" | "pieces">) {
	if (run.status !== "done") return false;
	const finished = run.agents.reduce((sum, agent) => sum + agent.finished.length, 0);
	return finished >= run.pieces;
}

/** What a demo run is doing, in a sentence, for the banner. */
export function runWords(run: DemoRunStatus, now = Date.now()): string {
	const finished = run.agents.reduce((sum, agent) => sum + agent.finished.length, 0);
	const done = `${finished} of ${counted(run.pieces, "piece")} finished`;
	if (run.status === "running") {
		const started = `Demo run ${run.number}, started by ${run.by} ${timeAgo(new Date(run.startedAt).toISOString(), now)}`;
		if (run.reset) return `${started}: putting the starting files back (${run.reset}) before its agents start.`;
		const building = run.agents.filter((agent) => agent.change).length;
		const reviewing = run.agents.filter((agent) => agent.reviewing).length;
		return `${started}: ${building} building, ${reviewing} reviewing, ${done}.`;
	}
	const ended = run.endedAt ? ` ${timeAgo(new Date(run.endedAt).toISOString(), now)}` : "";
	if (run.status === "done") return `Demo run ${run.number} finished${ended}: ${done}.`;
	return `Demo run ${run.number} was stopped${ended}, long past its time: ${done}.`;
}

/** The banner on the demo repo's Hive tab; nothing for any other repo. */
export function DemoBanner({
	repo,
	load,
	changed,
}: {
	repo: string;
	load: (repo: string) => Promise<DemoRunStatus>;
	/** What the live feed reads again on each ping: the banner follows it. */
	changed?: unknown;
}) {
	// Any other repo answers 404 at once: stop asking.
	const [absent, setAbsent] = useState(false);
	const run = usePoll(absent ? null : `demo:${repo}`, () => load(repo), 15_000);
	const refresh = run.refresh;
	useEffect(() => {
		if (!absent) refresh();
	}, [changed, absent, refresh]);
	const missing = !!run.error && !run.data;
	useEffect(() => {
		if (missing) setAbsent(true);
	}, [missing]);
	if (!run.data) return null;
	return (
		<p className={`callout demo-banner demo-banner--${run.data.status}`} role="status">
			{runWords(run.data)} Thirteen of GitHive's agents, each named for a job in a hive, work on their own: they review
			one another's changes and take pieces of the backlog, and nothing assigns the work.{" "}
			{gameLanded(run.data) ? <PlayLink repo={repo} /> : null}
		</p>
	);
}

/** The game the last run built, served from the demo repo's files (see src/routes/site.ts). */
function PlayLink({ repo }: { repo: string }) {
	return (
		<a className="demo-play" href={href.site(repo)} target="_blank" rel="noopener noreferrer">
			Play the game
		</a>
	);
}
