import { useEffect, useState } from "react";
import type { DemoRunStatus } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { messageOf, sentence } from "../lib/errors";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Box, calloutVariants } from "./ui/box";
import { Button } from "./ui/button";

// Honeycomb demo runs on the dashboard: the card that starts one, and the banner on the demo repo's Hive tab that says
// how it's going. A run is GitHive's own agents building a small word game again, in GitHive's one public demo repo.

export interface DemoApi {
	start(): Promise<{ id: string; repo: string }>;
	runs(): Promise<{ running: { fullName: string } | null; newest?: DemoRunStatus | null }>;
}

const STRIP_DISMISSED = "githive:demo-strip-dismissed";

function readStripDismissed(): boolean {
	try {
		return localStorage.getItem(STRIP_DISMISSED) === "1";
	} catch {
		return false;
	}
}

/** "0:42": how long since `since`, ticking each second. */
function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	return (
		<span className="tabular-nums">
			{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
		</span>
	);
}

/**
 * Starting a demo run: the runs as last read, and start(), which makes one and opens its repo once it's set up. A run
 * refused (another is going, or today's are used up) reads the runs again, so a run going shows as one to watch.
 */
function useDemoStart(api: DemoApi) {
	const runs = usePoll("demo:runs", () => api.runs(), 30_000);
	const [settingUpSince, setSettingUpSince] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const start = async () => {
		setSettingUpSince(Date.now());
		setError(null);
		try {
			const made = await api.start();
			// The run makes its repo itself, a few seconds on: open it once it's there, or say why the run failed.
			const failed = await setUpOf(api, made.id);
			if (failed) {
				setError(sentence(failed));
				setSettingUpSince(null);
				return;
			}
			window.location.hash = href.repo(made.repo);
		} catch (err) {
			setError(messageOf(err));
			setSettingUpSince(null);
			runs.refresh();
		}
	};
	return { runs, running: runs.data?.running, newest: runs.data?.newest, settingUpSince, error, start };
}

/**
 * Starts a demo run and opens its repo's Hive tab; or says a run is going, or why one can't start. Prominent for an
 * account with no repositories; otherwise a line, which can be put away.
 */
export function DemoCard({ api, compact = false }: { api: DemoApi; compact?: boolean }) {
	const { runs, running, newest, settingUpSince, error, start } = useDemoStart(api);
	const [stripDismissed, setStripDismissed] = useState(readStripDismissed);
	// Once the runs are read, what they change (a run going, a game to play) fades in.
	const appear = useChanged(runs.loaded) && "animate-fade";
	const busy = settingUpSince !== null;
	// A run refused because another started first: the card offers that one to watch, and says why.
	const said = running && error ? "Another demo run started first. Watch it instead." : error;
	const action = running ? (
		<Button asChild size={compact ? "sm" : "default"} className={cn(appear)}>
			<a href={href.repo(running.fullName)}>Watch the run going now</a>
		</Button>
	) : (
		<Button variant="primary" size={compact ? "sm" : "default"} onClick={start} disabled={busy}>
			{busy ? "Setting up the repo…" : "Start a demo run"}
		</Button>
	);
	const settingUp =
		settingUpSince !== null ? (
			<p className="m-0 text-meta text-muted-foreground" role="status">
				<span aria-hidden="true">
					<Elapsed since={settingUpSince} /> ·{" "}
				</span>
				It can take up to 2 minutes.
			</p>
		) : null;
	const problem = said ? (
		<p className={cn("m-0 animate-appear", running ? "text-ui" : "text-bad")} role={running ? "status" : "alert"}>
			{said}
		</p>
	) : null;

	if (compact) {
		if (stripDismissed) return null;
		return (
			<section
				aria-labelledby="demo-card-title"
				className="mb-5 flex animate-fade flex-wrap items-center gap-x-4 gap-y-2 border-l-3 border-l-link bg-surface-2 py-2 pr-2 pl-3.5"
			>
				<p className="m-0 min-w-0 flex-[1_1_320px] text-ui">
					<strong id="demo-card-title">Watch a hive build a game.</strong>{" "}
					<span className="text-muted-foreground">
						Thirteen of GitHive's agents build Honeycomb, a word game, in about 10 minutes.
					</span>
				</p>
				<div className="flex flex-wrap items-center gap-2">
					{newest && gameLanded(newest) ? <PlayLink repo={newest.fullName} className={cn("text-ui", appear)} /> : null}
					{action}
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label="Dismiss the demo"
						onClick={() => {
							try {
								localStorage.setItem(STRIP_DISMISSED, "1");
							} catch {
								// Without storage, it's put away until the page reloads.
							}
							setStripDismissed(true);
						}}
					>
						<Icon name="x" />
					</Button>
				</div>
				{settingUp || problem ? (
					<div className="grid basis-full gap-1">
						{settingUp}
						{problem}
					</div>
				) : null}
			</section>
		);
	}

	return (
		<Box
			className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-l-3 border-l-link px-5 py-4"
			aria-labelledby="demo-card-title"
		>
			<div className="min-w-0 flex-[1_1_360px]">
				<h2 id="demo-card-title" className="mb-1.5 text-lead">
					Watch a hive build Honeycomb (Demo Game)
				</h2>
				<p className="m-0 text-muted-foreground">
					Thirteen of GitHive's own agents build a small word game in GitHive's public demo repo, starting over from its
					first files. Nothing assigns the work: each takes a piece from the backlog, claims its files, builds it, gets
					it reviewed and tested, and lands it. It takes about 10 minutes, and you can play the game when it's done.
				</p>
				{problem}
			</div>
			<div className="flex flex-none flex-col items-end gap-2">
				{action}
				{settingUp}
				{newest && gameLanded(newest) ? <PlayLink repo={newest.fullName} className={cn(appear)} /> : null}
			</div>
		</Box>
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

const SETUP_POLL_MS = 2_000;
const SETUP_POLLS = 60;

/**
 * Waits for run `id` to be set up: resolves with why it failed, if it did, and otherwise once it's set up, or after
 * two minutes of asking, when opening its repo is as good as waiting longer.
 */
export async function setUpOf(
	api: Pick<DemoApi, "runs">,
	id: string,
	wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | undefined> {
	for (let poll = 0; poll < SETUP_POLLS; poll++) {
		const { newest } = await api.runs();
		const run = newest?.id === id ? newest : undefined;
		if (run?.status === "failed") return run.error ?? "the demo run couldn't be set up";
		if (run && !run.settingUp) return undefined;
		await wait(SETUP_POLL_MS);
	}
	return undefined;
}

/** What a demo run is doing, in a sentence, for the banner. */
export function runWords(run: DemoRunStatus, now = Date.now()): string {
	const finished = run.agents.reduce((sum, agent) => sum + agent.finished.length, 0);
	const done = `${finished} of ${counted(run.pieces, "piece")} finished`;
	if (run.status === "running") {
		const started = `Demo run ${run.number}, started by ${run.by} ${timeAgo(new Date(run.startedAt).toISOString(), now)}`;
		if (run.settingUp) return `${started}: setting the repo up for its agents.`;
		if (run.reset) return `${started}: putting the starting files back (${run.reset}) before its agents start.`;
		const building = run.agents.filter((agent) => agent.change).length;
		const reviewing = run.agents.filter((agent) => agent.reviewing).length;
		return `${started}: ${building} building, ${reviewing} reviewing, ${done}.`;
	}
	const ended = run.endedAt ? ` ${timeAgo(new Date(run.endedAt).toISOString(), now)}` : "";
	if (run.status === "done") return `Demo run ${run.number} finished${ended}: ${done}.`;
	if (run.status === "failed")
		return `Demo run ${run.number} couldn't start${ended}: ${run.error ?? "its repo couldn't be set up"}.`;
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
		<p className={cn(calloutVariants(), "m-0 animate-appear")} role="status">
			{runWords(run.data)} Thirteen of GitHive's agents, each named for a job in a hive, work on their own: they review
			one another's changes and take pieces of the backlog, and nothing assigns the work.{" "}
			{gameLanded(run.data) ? <PlayLink repo={repo} /> : null}
		</p>
	);
}

/** The game the last run built, served from the demo repo's files (see src/routes/site.ts). */
function PlayLink({ repo, className }: { repo: string; className?: string }) {
	return (
		<a className={cn("whitespace-nowrap", className)} href={href.site(repo)} target="_blank" rel="noopener noreferrer">
			Play the game
		</a>
	);
}
