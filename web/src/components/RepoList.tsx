import { type ReactNode, useState } from "react";
import { filterRepos, groupRepos, type RepoRow, type RepoState, repoState } from "../lib/repos";
import { stretchWords } from "../lib/stretch";
import { splitRepo } from "../lib/repoName";
import { href } from "../lib/routes";
import { timeAgo } from "../lib/relativeTime";
import { DemoCard, type DemoApi } from "./DemoRun";
import { Icon } from "./Icon";
import "./RepoList.css";

export interface RepoListProps {
	rows: RepoRow[];
	loaded: boolean;
	/** A person signed in to GitHive, who can make repositories and organizations. */
	canCreate?: boolean;
	/** Demo runs, which a person signed in can start. */
	demo?: DemoApi;
}

const LAMP: Record<RepoState, string> = {
	"needs-you": "lamp--red",
	"at-work": "lamp--amber",
	done: "lamp--green",
	quiet: "lamp--neutral",
};

/** Every repo in a line: how many, how many need you, and how much is open across them. */
function Summary({ rows }: { rows: RepoRow[] }) {
	const needsYou = rows.reduce((n, row) => n + row.needsYou, 0);
	const violations = rows.reduce((n, row) => n + row.violations, 0);
	const open = rows.reduce((n, row) => n + row.open, 0);
	return (
		<p className="overview__summary repo-list__summary">
			<strong>
				{rows.length} {rows.length === 1 ? "repository" : "repositories"}
			</strong>
			{needsYou ? (
				<span className="overview__count lamp--red">
					<span className="lamp" aria-hidden="true" />
					{needsYou} {needsYou === 1 ? "change needs" : "changes need"} you
				</span>
			) : null}
			{violations ? (
				<span className="overview__count lamp--red">
					<span className="lamp" aria-hidden="true" />
					{violations} audit {violations === 1 ? "violation" : "violations"}
				</span>
			) : null}
			<span className="overview__count lamp--amber">
				<span className="lamp" aria-hidden="true" />
				{open} open {open === 1 ? "change" : "changes"}
			</span>
		</p>
	);
}

/** When the repo was last active, or, once a stretch of work has just landed, when it finished. */
function LastSeen({ row, done }: { row: RepoRow; done: boolean }) {
	if (done && row.stretch) return <span className="muted">Finished {timeAgo(row.stretch.to)}.</span>;
	if (!row.lastActivity) return null;
	return <span className="muted">Active {timeAgo(row.lastActivity)}.</span>;
}

/** One repo: its lamp, its name, and what's going on in it, in a sentence. */
function RepoLine({ row }: { row: RepoRow }) {
	const { owner, name } = splitRepo(row.name);
	const state = repoState(row);
	const parts: ReactNode[] = [];
	if (row.needsYou)
		parts.push(
			<strong key="needs" className="tone-needs">
				{row.needsYou} {row.needsYou === 1 ? "change needs" : "changes need"} you
			</strong>,
		);
	if (row.violations)
		parts.push(
			<strong key="violations" className="tone-bad">
				{row.violations} audit {row.violations === 1 ? "violation" : "violations"}
			</strong>,
		);
	if (state === "done" && row.stretch)
		parts.push(
			<span key="done">
				<strong className="tone-good">✓ All landed</strong>: {stretchWords(row.stretch)}
			</span>,
		);
	if (row.open) parts.push(<span key="open">{row.open} open</span>);
	if (row.merged) parts.push(<span key="merged">{row.merged} merged</span>);
	return (
		<li className="repo-row">
			<span className={`lamp repo-row__lamp ${LAMP[state]}`} aria-hidden="true" />
			<div className="repo-row__main">
				<a className="repo-row__name" href={href.repo(row.name)}>
					<span className="repo-row__owner">{owner}/</span>
					{name}
				</a>
				<p className="repo-row__meta">
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
		</li>
	);
}

/** The repos, grouped by whether they need someone; or why there are none to show. */
function RepoGroups(props: { rows: RepoRow[]; loaded: boolean; shown: RepoRow[]; query: string; canCreate: boolean }) {
	const { rows, loaded, shown, query, canCreate } = props;
	if (!loaded && rows.length === 0)
		return (
			<p className="box__row muted" role="status">
				Loading repositories…
			</p>
		);
	if (rows.length === 0)
		return (
			<div className="empty">
				<Icon name="repo" size={32} className="muted" />
				<h2>No repositories yet</h2>
				<p>
					Make one under your name or an organization's, and GitHive starts on it at once. Agents claim the paths they
					will change, push their changes to their own forks, and merge them after review and checks, just like pull
					requests.
				</p>
				{canCreate ? (
					<div className="empty__actions">
						<a className="button" href={href.newRepo()}>
							<Icon name="plus" size={15} /> New repository
						</a>
					</div>
				) : null}
			</div>
		);
	if (shown.length === 0) return <p className="box__row muted">No repositories match “{query}”.</p>;
	return groupRepos(shown).map((group) => (
		<section key={group.state} className="repo-group" aria-labelledby={`repos-${group.state}`}>
			<h2 id={`repos-${group.state}`} className="repo-group__title">
				{group.title} <span className="muted">{group.rows.length}</span>
			</h2>
			<ul className="repo-list__rows">
				{group.rows.map((row) => (
					<RepoLine key={row.name} row={row} />
				))}
			</ul>
		</section>
	));
}

/** Other people's public repos the reader can open, apart from their own. */
function PublicRepos({ rows }: { rows: RepoRow[] }) {
	if (!rows.length) return null;
	return (
		<section className="repo-group" aria-labelledby="repos-public">
			<h2 id="repos-public" className="repo-group__title">
				Public <span className="muted">{rows.length}</span>
			</h2>
			<ul className="repo-list__rows">
				{rows.map((row) => (
					<RepoLine key={row.name} row={row} />
				))}
			</ul>
		</section>
	);
}

/**
 * The home page: the reader's own repos (theirs, their orgs' and those shared with them), those that need a person
 * first, then those at work, then the quiet ones; then other people's public repos, apart.
 */
export function RepoList({ rows: all, loaded, canCreate = false, demo }: RepoListProps) {
	const [query, setQuery] = useState("");
	const rows = all.filter((row) => !row.public);
	const others = filterRepos(
		all.filter((row) => row.public),
		query,
	);
	const shown = filterRepos(rows, query);

	return (
		<main className="page repo-list" id="main">
			<div className="page__header repo-list__header">
				<div className="repo-list__heading">
					<h1>Repositories</h1>
					{rows.length ? <Summary rows={rows} /> : null}
				</div>
				{canCreate ? (
					<div className="repo-list__actions">
						<a className="button" href={href.orgs()}>
							Create an organization
						</a>
						<a className="button accent-link" href={href.newRepo()}>
							<Icon name="plus" size={15} /> New repository
						</a>
					</div>
				) : null}
			</div>

			{demo ? <DemoCard api={demo} /> : null}

			{all.length > 0 ? (
				<div className="repo-list__search">
					<Icon name="search" className="repo-list__search-icon" />
					<label className="sr-only" htmlFor="repo-search">
						Find a repository
					</label>
					<input
						id="repo-search"
						type="search"
						placeholder="Find a repository…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
			) : null}

			<div className="repo-list__groups" aria-label="Repositories">
				<RepoGroups rows={rows} loaded={loaded} shown={shown} query={query} canCreate={canCreate} />
				<PublicRepos rows={others} />
			</div>
		</main>
	);
}
