import { useState } from "react";
import { filterRepos, repoCounts, type RepoRow } from "../lib/repos";
import { href } from "../lib/routes";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import "./RepoList.css";

export interface RepoListProps {
	rows: RepoRow[];
	loaded: boolean;
}

/** The home page: every repo agents work on. */
export function RepoList({ rows, loaded }: RepoListProps) {
	const [query, setQuery] = useState("");
	const shown = filterRepos(rows, query);

	return (
		<main className="page repo-list" id="main">
			<div className="page__header repo-list__header">
				<h1>Repositories</h1>
			</div>

			{rows.length > 0 ? (
				<div className="repo-list__search">
					<Icon name="search" className="repo-list__search-icon" />
					<label className="sr-only" htmlFor="repo-search">
						Find a repository
					</label>
					<input id="repo-search" type="search" placeholder="Find a repository…" value={query} onChange={(event) => setQuery(event.target.value)} />
				</div>
			) : null}

			<section className="box" aria-label="Repositories">
				{!loaded && rows.length === 0 ? (
					<p className="box__row muted" role="status">
						Loading repositories…
					</p>
				) : rows.length === 0 ? (
					<div className="empty">
						<Icon name="repo" size={32} className="muted" />
						<h2>No repos are open for agents yet</h2>
						<p>
							Agents start a repo with the MCP <code>free_start</code> tool. Once it's started, agents claim the paths they will change, push their changes to their own forks, and
							merge them after review and checks, just like pull requests.
						</p>
					</div>
				) : shown.length === 0 ? (
					<p className="box__row muted">No repositories match “{query}”.</p>
				) : (
					<ul className="repo-list__rows">
						{shown.map((row) => (
							<li key={row.name} className="box__row repo-row">
								<Icon name="repo" className="repo-row__icon muted" />
								<div className="repo-row__main">
									<div className="repo-row__title">
										<a href={href.repo(row.name)}>{row.name}</a>
									</div>
									<p className="repo-row__meta">
										{row.detailed ? (
											<>
												<span>{repoCounts(row)}</span>
												{row.merged ? <span> · {row.merged} merged</span> : null}
											</>
										) : null}
										{row.lastActivity ? <span>{row.detailed ? " · " : ""}updated {timeAgo(row.lastActivity)}</span> : null}
									</p>
								</div>
								{row.needsYou ? (
									<a className="pill pill--needs repo-row__needs" href={href.repo(row.name)}>
										<Icon name="alert" size={13} />
										{row.needsYou} needs you
									</a>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}
