import { useEffect, useRef, useState } from "react";
import { filterRepos, repoCounts, type RepoRow } from "../lib/repos";
import { href } from "../lib/routes";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import { OpenRepoForm } from "./OpenRepoForm";
import { ModeBadge } from "./StatusPill";
import "./RepoList.css";

export interface RepoListProps {
	rows: RepoRow[];
	loaded: boolean;
	/** Every repo in the account, for the Open a repo form. */
	allRepos: { name: string }[];
	opening: boolean;
	openError?: string;
	onOpenRepo(repo: string): void;
	/** Start with the Open a repo dialog shown (tests, deep links). */
	initiallyOpen?: boolean;
}

/** The home page: every repo agents work on, in either mode. */
export function RepoList({ rows, loaded, allRepos, opening, openError, onOpenRepo, initiallyOpen = false }: RepoListProps) {
	const [query, setQuery] = useState("");
	const [dialogOpen, setDialogOpen] = useState(initiallyOpen);
	const dialog = useRef<HTMLDialogElement>(null);
	const shown = filterRepos(rows, query);

	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		if (dialogOpen && !element.open) element.showModal?.();
		if (!dialogOpen && element.open) element.close();
	}, [dialogOpen]);

	// Close the dialog once the repo opened (the parent navigates away).
	const wasOpening = useRef(opening);
	useEffect(() => {
		if (wasOpening.current && !opening && !openError) setDialogOpen(false);
		wasOpening.current = opening;
	}, [opening, openError]);

	const openButton = (
		<button type="button" className="primary" onClick={() => setDialogOpen(true)}>
			<Icon name="plus" />
			Open a repo
		</button>
	);

	return (
		<main className="page repo-list" id="main">
			<div className="page__header repo-list__header">
				<h1>Repositories</h1>
				{openButton}
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
							Agents join a repo with the MCP <code>join_repo</code> tool, or you can open one here. Once a repo is open, agents claim the paths they will change, open changes, and
							merge them after review and checks, just like pull requests.
						</p>
						<div className="empty__actions">{openButton}</div>
					</div>
				) : shown.length === 0 ? (
					<p className="box__row muted">No repositories match “{query}”.</p>
				) : (
					<ul className="repo-list__rows">
						{shown.map((row) => (
							<li key={`${row.mode}:${row.name}`} className="box__row repo-row">
								<Icon name="repo" className="repo-row__icon muted" />
								<div className="repo-row__main">
									<div className="repo-row__title">
										<a href={href.repo(row.name, "changes", row.mode === "coordinator-free" ? "free" : "repos")}>{row.name}</a>
										<ModeBadge mode={row.mode} />
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
									<a className="pill pill--needs repo-row__needs" href={href.repo(row.name, "changes", row.mode === "coordinator-free" ? "free" : "repos")}>
										<Icon name="alert" size={13} />
										{row.needsYou} needs you
									</a>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>

			<dialog ref={dialog} className="dialog" aria-label="Open a repo" onClose={() => setDialogOpen(false)}>
				{dialogOpen ? <OpenRepoForm repos={allRepos} opening={opening} error={openError} onOpen={onOpenRepo} onCancel={() => setDialogOpen(false)} /> : null}
			</dialog>
		</main>
	);
}
