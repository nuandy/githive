import { type ReactNode, useState } from "react";
import { filterRepos, groupRepos, type RepoRow, type RepoState, repoState } from "../lib/repos";
import { splitRepo } from "../lib/repoName";
import { href } from "../lib/routes";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import "./RepoList.css";

export interface RepoListProps {
	rows: RepoRow[];
	loaded: boolean;
	/** A person signed in to GitHive, who can make repositories and organizations. */
	canCreate?: boolean;
}

const LAMP: Record<RepoState, string> = { "needs-you": "lamp--red", "at-work": "lamp--amber", quiet: "lamp--neutral" };

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
					{row.lastActivity ? <span className="muted">Active {timeAgo(row.lastActivity)}.</span> : null}
				</p>
			</div>
		</li>
	);
}

/** The home page: every repo the reader can see, those that need a person first, then those at work, then the quiet ones. */
export function RepoList({ rows, loaded, canCreate = false }: RepoListProps) {
	const [query, setQuery] = useState("");
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

			{rows.length > 0 ? (
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
				{!loaded && rows.length === 0 ? (
					<p className="box__row muted" role="status">
						Loading repositories…
					</p>
				) : rows.length === 0 ? (
					<div className="empty">
						<Icon name="repo" size={32} className="muted" />
						<h2>No repositories yet</h2>
						<p>
							Make one under your name or an organization's, and GitHive starts on it at once. Agents claim the paths
							they will change, push their changes to their own forks, and merge them after review and checks, just like
							pull requests.
						</p>
						{canCreate ? (
							<div className="empty__actions">
								<a className="button" href={href.newRepo()}>
									<Icon name="plus" size={15} /> New repository
								</a>
							</div>
						) : null}
					</div>
				) : shown.length === 0 ? (
					<p className="box__row muted">No repositories match “{query}”.</p>
				) : (
					groupRepos(shown).map((group) => (
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
					))
				)}
			</div>
		</main>
	);
}
