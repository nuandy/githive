import { useState } from "react";
import type { DemoRunStatus } from "../api";
import { usePoll } from "../hooks/usePoll";
import { messageOf } from "../lib/errors";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import "./DemoRun.css";

// Honeycomb demo runs on the dashboard: the card that starts one, and the banner on a demo repo's Hive tab that says how
// it's going. A run is GitHive's own agents building a small word game in a new public repo of the person's own.

export interface DemoApi {
	start(): Promise<{ id: string; repo: string }>;
	runs(): Promise<{ running: { fullName: string } | null }>;
}

/** Starts a demo run and opens its repo's Hive tab; or says a run is going, or why one can't start. */
export function DemoCard({ api }: { api: DemoApi }) {
	const runs = usePoll("demo:runs", () => api.runs(), 30_000);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const running = runs.data?.running;
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
				<h2 id="demo-card-title">Watch a hive build Honeycomb</h2>
				<p className="muted">
					Six of GitHive's own agents build a small word game in a new public repo of yours. Nothing assigns the work:
					each takes a piece from the backlog, claims its files, builds it, gets it reviewed and tested, and lands it.
					It takes about half an hour, and you can play the game when it's done.
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
			</div>
		</section>
	);
}

/** What a demo run is doing, in a sentence, for the banner. */
export function runWords(run: DemoRunStatus, now = Date.now()): string {
	const finished = run.agents.reduce((sum, agent) => sum + agent.finished.length, 0);
	const done = `${finished} of ${counted(run.pieces, "piece")} finished`;
	if (run.status === "running") {
		const building = run.agents.filter((agent) => agent.change).length;
		const reviewing = run.agents.filter((agent) => agent.reviewing).length;
		const started = timeAgo(new Date(run.startedAt).toISOString(), now);
		return `A demo run, started by ${run.by} ${started}: ${building} building, ${reviewing} reviewing, ${done}.`;
	}
	const ended = run.endedAt ? ` ${timeAgo(new Date(run.endedAt).toISOString(), now)}` : "";
	if (run.status === "done") return `This demo run finished${ended}: ${done}.`;
	return `This demo run was stopped${ended}, long past its time: ${done}.`;
}

/** The banner on a demo repo's Hive tab; nothing for a repo no demo run made. */
export function DemoBanner({ repo, load }: { repo: string; load: (repo: string) => Promise<DemoRunStatus> }) {
	const run = usePoll(`demo:${repo}`, () => load(repo), 15_000);
	if (!run.data) return null;
	return (
		<p className={`callout demo-banner demo-banner--${run.data.status}`} role="status">
			{runWords(run.data)} Six of GitHive's agents, named for jobs in a hive (githive-forager, githive-scout…), each run
			on their own: they review one another's changes and take pieces of the backlog, and nothing assigns the work.
		</p>
	);
}
