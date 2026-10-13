import { type ReactNode, useState } from "react";
import { useChanged } from "../hooks/useChanged";
import { useStagger } from "../hooks/useStagger";
import { filterRepos, groupRepos, type RepoRow, type RepoState, repoState } from "../lib/repos";
import { stretchWords } from "../lib/stretch";
import { splitRepo } from "../lib/repoName";
import type { ChangeState } from "../lib/status";
import { href } from "../lib/routes";
import { timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import { DemoCard, type DemoApi } from "./DemoRun";
import { GetStarted, type StartApi } from "./GetStarted";
import { Icon } from "./Icon";
import { Page, PageHeader } from "./Page";
import { Lamp } from "./ui/badge";
import { Box } from "./ui/box";
import { Button } from "./ui/button";
import { Fold } from "./ui/collapse";
import { Input } from "./ui/field";

export interface RepoListProps {
	rows: RepoRow[];
	loaded: boolean;
	/** A person signed in to GitHive, who can make repositories and organizations. */
	canCreate?: boolean;
	/** Demo runs, which a person signed in can start. */
	demo?: DemoApi;
	/** Your agents and apps, for the Get started checklist (people signed in). */
	start?: StartApi;
	/** The search, as the address has it (#/?q=…), and keeping it there as it's typed. */
	query?: string;
	onQueryChange?: (query: string) => void;
}

/** A repo's lamp: what needs a person, work being built, or work landed, as a change's lamp says each; quiet is unlit. */
const LAMP: Record<RepoState, ChangeState | undefined> = {
	"needs-you": "needs-person",
	"at-work": "building",
	done: "landed",
	quiet: undefined,
};

/** A count beside the total, marked by its lamp. */
function Count({ state, children }: { state: ChangeState; children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.75 text-muted-foreground">
			<Lamp state={state} />
			{children}
		</span>
	);
}

/** Every repo in a line: how many, how many need you, and how much is open across them. */
function Summary({ rows, className }: { rows: RepoRow[]; className?: string }) {
	const needsYou = rows.reduce((n, row) => n + row.needsYou, 0);
	const violations = rows.reduce((n, row) => n + row.violations, 0);
	const open = rows.reduce((n, row) => n + row.open, 0);
	return (
		<p className={cn("m-0 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-lead", className)}>
			<strong>
				{rows.length} {rows.length === 1 ? "repository" : "repositories"}
			</strong>
			{needsYou ? (
				<Count state="needs-person">
					{needsYou} {needsYou === 1 ? "change needs" : "changes need"} you
				</Count>
			) : null}
			{violations ? (
				<Count state="needs-person">
					{violations} audit {violations === 1 ? "violation" : "violations"}
				</Count>
			) : null}
			<Count state="building">
				{open} open {open === 1 ? "change" : "changes"}
			</Count>
		</p>
	);
}

/** When the repo was last active, or, once a stretch of work has just landed, when it finished. */
function LastSeen({ row, done }: { row: RepoRow; done: boolean }) {
	if (done && row.stretch) return <span className="text-muted-foreground">Finished {timeAgo(row.stretch.to)}.</span>;
	if (!row.lastActivity) return null;
	return <span className="text-muted-foreground">Active {timeAgo(row.lastActivity)}.</span>;
}

/** One repo: its lamp, its name, and what's going on in it, in a sentence. Under another, a rule between them. */
function RepoLine({ row, ruled }: { row: RepoRow; ruled: boolean }) {
	const { owner, name } = splitRepo(row.name);
	const state = repoState(row);
	const parts: ReactNode[] = [];
	if (row.needsYou)
		parts.push(
			<strong key="needs" className="text-needs">
				{row.needsYou} {row.needsYou === 1 ? "change needs" : "changes need"} you
			</strong>,
		);
	if (row.violations)
		parts.push(
			<strong key="violations" className="text-bad">
				{row.violations} audit {row.violations === 1 ? "violation" : "violations"}
			</strong>,
		);
	if (state === "done" && row.stretch)
		parts.push(
			<span key="done">
				<strong className="text-good">✓ All landed</strong>: {stretchWords(row.stretch)}
			</span>,
		);
	if (row.open) parts.push(<span key="open">{row.open} open</span>);
	if (row.merged) parts.push(<span key="landed">{row.merged} landed</span>);
	return (
		<div className={cn("flex items-start gap-3.5 px-0.5 py-3.5", ruled && "border-t border-border")}>
			{/* A quiet repo's lamp is unlit: an empty ring rather than a grey dot. */}
			<Lamp
				state={LAMP[state]}
				className={cn(
					"mt-1.75",
					state === "quiet" && "bg-transparent [box-shadow:inset_0_0_0_1.5px_var(--border-strong)]",
				)}
			/>
			<div className="min-w-0 flex-1">
				<a className="text-lead font-bold wrap-anywhere text-foreground" href={href.repo(row.name)}>
					<span className="font-normal text-muted-foreground">{owner}/</span>
					{name}
				</a>
				<p className="mt-0.5 mb-0 text-body-sm">
					{parts.map((part, i) => (
						<span key={i}>
							{i ? ", " : ""}
							{part}
						</span>
					))}
					{parts.length ? ". " : ""}
					<LastSeen row={row} done={state === "done"} />
				</p>
			</div>
		</div>
	);
}

/** How many a group shows; it bumps as the number changes. */
function GroupCount({ count }: { count: number }) {
	const changed = useChanged(count);
	return (
		<span key={count} className={cn("font-normal text-muted-foreground tabular-nums", changed && "animate-bump")}>
			{count}
		</span>
	);
}

/**
 * A group of repos under its title, ruled off from the group above when `spaced`. The repos a search leaves out fold
 * away, and unfold as they come back; with none left, the whole group folds away.
 */
function RepoGroup(props: {
	id: string;
	title: string;
	rows: RepoRow[];
	matches: (row: RepoRow) => boolean;
	spaced: boolean;
}) {
	const { id, title, rows, matches, spaced } = props;
	const shown = rows.filter(matches);
	const staggers = useStagger(rows.length > 0);
	// While it folds away, it still counts what it last showed.
	const [count, setCount] = useState(shown.length);
	if (shown.length && shown.length !== count) setCount(shown.length);
	let above = 0;
	return (
		<Fold open={shown.length > 0}>
			<Box aria-labelledby={id} className={cn("transition-[margin] duration-slow ease-out", spaced && "mt-8")}>
				<h2 id={id} className="flex items-baseline gap-2 border-b border-border px-0.5 pt-2.5 pb-2.25 text-body">
					{title} <GroupCount count={count} />
				</h2>
				<ul className={cn("m-0 list-none p-0", staggers && "stagger")}>
					{rows.map((row) => {
						const match = matches(row);
						const ruled = match && above++ > 0;
						return (
							<li key={row.name} className="empty:hidden">
								<Fold open={match}>
									<RepoLine row={row} ruled={ruled} />
								</Fold>
							</li>
						);
					})}
				</ul>
			</Box>
		</Fold>
	);
}

/** No repositories to list: what they're for. The page's header has the way to make one. */
function NoRepos() {
	return (
		<div className="px-6 py-10 text-center">
			<Icon name="repo" size={28} className="inline align-baseline text-muted-foreground" />
			<h2 className="mt-3 mb-2 text-title">No repositories yet</h2>
			<p className="mx-auto mt-0 mb-2 max-w-130 text-muted-foreground">
				Make one under your name or an organization's, and GitHive starts on it at once. Agents claim the paths they
				will change, push their changes to their own forks, and land them after review and checks, just like pull
				requests.
			</p>
		</div>
	);
}

// A line in the list in place of repos: that they're loading, or that none match.
const NOTE = "my-3.75 border-t border-border px-0.5 py-3 text-muted-foreground";

/**
 * The home page: the reader's own repos (theirs, their orgs' and those shared with them), those that need a person
 * first, then those at work, then the quiet ones; then other people's public repos, apart.
 */
export function RepoList({
	rows: all,
	loaded,
	canCreate = false,
	demo,
	start,
	query: asked = "",
	onQueryChange,
}: RepoListProps) {
	const [query, setQuery] = useState(asked);
	const rows = all.filter((row) => !row.public);
	const others = all.filter((row) => row.public);
	const matching = new Set(filterRepos(all, query).map((row) => row.name));
	const matches = (row: RepoRow) => matching.has(row.name);

	const phase = rows.length ? "list" : loaded ? "empty" : "loading";
	// What comes once the repos are read fades in, as the list takes the place of "Loading…"; what's there at once comes
	// in with the page's own fade.
	const summaryFades = useChanged(rows.length > 0);
	const searchFades = useChanged(all.length > 0);
	const listFades = useChanged(phase);
	const noMatch = phase === "list" && !rows.some(matches);
	// While "none match" folds away, it still says what didn't.
	const [missed, setMissed] = useState(query);
	if (noMatch && missed !== query) setMissed(query);

	const groups = (phase === "list" ? groupRepos(rows) : []).map((group) => ({
		id: `repos-${group.state}`,
		title: group.title,
		rows: group.rows,
	}));
	if (others.length) groups.push({ id: "repos-public", title: "Public", rows: others });
	// A group stands apart from what shows above it: a note in place of repos, or another group.
	let shownAbove = phase !== "list" || noMatch;

	return (
		<Page>
			<PageHeader
				title="Repositories"
				className="items-center"
				actions={
					canCreate ? (
						<>
							<Button asChild>
								<a href={href.orgs()}>Create an organization</a>
							</Button>
							<Button asChild variant="primary">
								<a href={href.newRepo()}>
									<Icon name="plus" /> New repository
								</a>
							</Button>
						</>
					) : null
				}
			>
				{rows.length ? <Summary rows={rows} className={cn(summaryFades && "animate-fade")} /> : null}
			</PageHeader>

			{start ? (
				<GetStarted rows={rows} loaded={loaded} api={start} elsewhere={canCreate ? [href.newRepo()] : []} />
			) : null}
			{/* Prominent for an account with no repositories; otherwise a line. */}
			{demo && phase !== "loading" ? <DemoCard api={demo} compact={phase === "list"} /> : null}

			{all.length > 0 ? (
				<div className={cn("relative mb-4", searchFades && "animate-fade")}>
					<Icon name="search" className="pointer-events-none absolute top-2.5 left-2.75 text-muted-foreground" />
					<label className="sr-only" htmlFor="repo-search">
						Find a repository
					</label>
					<Input
						id="repo-search"
						type="search"
						className="h-9 w-full pl-8.5"
						placeholder="Find a repository…"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							onQueryChange?.(event.target.value);
						}}
					/>
				</div>
			) : null}

			<div key={phase} className={cn("grid", listFades && "animate-fade")} aria-label="Repositories">
				{phase === "loading" ? (
					<p className={NOTE} role="status">
						Loading repositories…
					</p>
				) : null}
				{phase === "empty" ? <NoRepos /> : null}
				{phase === "list" ? (
					<Fold open={noMatch}>
						<p className={NOTE}>No repositories match “{missed}”.</p>
					</Fold>
				) : null}
				{groups.map((group) => {
					const spaced = shownAbove;
					shownAbove ||= group.rows.some(matches);
					return <RepoGroup key={group.id} {...group} matches={matches} spaced={spaced} />;
				})}
			</div>
		</Page>
	);
}
