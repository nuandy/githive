import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FreeSnapshot, type Task } from "./api";
import { InboxPage } from "./components/InboxPage";
import { PageBoundary } from "./components/PageBoundary";
import { RepoList } from "./components/RepoList";
import { ElectedRepoPage, FreeRepoPage, type RepoView } from "./components/RepoPage";
import { TopBar, type Crumb } from "./components/TopBar";
import { useLiveFeed } from "./hooks/useLiveFeed";
import { usePoll } from "./hooks/usePoll";
import { claimTitle } from "./lib/freeStatus";
import { buildInbox } from "./lib/inbox";
import { changesOf } from "./lib/model";
import { buildRepoRows, openTaskId } from "./lib/repos";
import { href, parseRoute, type Route } from "./lib/routes";
import "./App.css";

/** Where a route points, ignoring tabs: moving to a different place scrolls to the top; switching tabs doesn't. */
export function routePlace(route: Route): string {
	if (route.page === "repo") return `repo:${route.base}:${route.repo}`;
	if (route.page === "change") return `change:${route.base}:${route.repo}:${route.change}`;
	return route.page;
}

export function useHashRoute(): Route {
	const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
	// Moving between files in the Code tab scrolls to the top too, without remounting the page.
	const scrollPlace = (r: Route) => `${routePlace(r)}${r.page === "repo" && r.tab === "code" ? `:code:${r.path ?? ""}:${r.ref ?? ""}` : ""}`;
	const place = useRef(scrollPlace(route));
	useEffect(() => {
		const onChange = () => {
			const next = parseRoute(window.location.hash);
			const nextPlace = scrollPlace(next);
			if (nextPlace !== place.current) window.scrollTo(0, 0);
			place.current = nextPlace;
			setRoute(next);
		};
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return route;
}

function Loading({ what }: { what: string }) {
	return (
		<main className="page" id="main">
			<p className="muted page__loading" role="status">
				Loading {what}…
			</p>
		</main>
	);
}

/** The open task id for `repo`, once computed; null while there is none to look for. */
function useOpenTaskId(repo: string | null): string | null {
	const [ids, setIds] = useState<{ repo: string; id: string } | null>(null);
	useEffect(() => {
		if (repo === null) return;
		let active = true;
		void openTaskId(repo).then((id) => active && setIds({ repo, id }));
		return () => {
			active = false;
		};
	}, [repo]);
	return repo !== null && ids?.repo === repo ? ids.id : null;
}

export function App() {
	const route = useHashRoute();
	const onRepos = route.page === "repos";
	const repoName = route.page === "repo" || route.page === "change" ? route.repo : null;
	const base = route.page === "repo" || route.page === "change" ? route.base : "repos";

	// Every repo's counts in one read: the Repositories list, and the Inbox count on every page.
	const summaries = usePoll("summaries", api.summaries, onRepos || route.page === "inbox" ? 15_000 : 30_000);
	const inbox = buildInbox(summaries.data);
	const free = usePoll("free", api.freeRepos, 10_000);
	const allRepos = usePoll(onRepos ? "repos" : null, api.repos, 60_000);

	// A repo just opened from the dialog shows at once, before the next list refresh.
	const [opened, setOpened] = useState<Task | null>(null);
	const [opening, setOpening] = useState(false);
	const [openError, setOpenError] = useState<string>();

	// A repo is coordinator-free if it's listed as such; otherwise its open task has a known id.
	const isFree = repoName !== null && (base === "free" || !!free.data?.some((repo) => repo.repo === repoName));
	const openId = useOpenTaskId(repoName !== null && free.loaded && !isFree ? repoName : null);

	// The repo's live feed: while it's connected, a ping triggers each refresh and polling slows to a safety net.
	const [feedTaskKnown, setFeedTaskKnown] = useState<string | null>(null);
	const feedKey = isFree ? `free:${repoName}` : openId && feedTaskKnown === openId ? `task:${openId}` : null;
	const refreshers = useRef<(() => void)[]>([]);
	const liveStatus = useLiveFeed(feedKey, () => refreshers.current.forEach((refresh) => refresh()));
	const every = (ms: number) => (liveStatus === "live" ? 30_000 : ms);

	const live = usePoll(openId ? `live:${openId}` : null, () => api.live(openId!), every(5_000));
	const history = usePoll(openId ? `history:${openId}` : null, () => api.history(openId!), every(15_000));
	const leader = usePoll(openId && live.data ? `leader:${openId}` : null, () => api.leader(openId!), 30_000);
	const snapshot = usePoll(isFree ? `free:${repoName}` : null, () => api.freeRepo(repoName!), every(5_000));
	// The audit replays every record in Git, so it loads on its own and less often.
	const audit = usePoll(isFree ? `audit:${repoName}` : null, () => api.freeAudit(repoName!), 60_000);
	const freeChangeId = isFree && route.page === "change" ? route.change : null;
	const freeChange = usePoll(freeChangeId ? `free-change:${repoName}:${freeChangeId}` : null, () => api.freeChange(repoName!, freeChangeId!), every(10_000));
	refreshers.current = [live.refresh, history.refresh, leader.refresh, snapshot.refresh, audit.refresh, freeChange.refresh];
	const task = openId && live.data?.task.id === openId ? live.data.task : opened && opened.repo === repoName ? opened : undefined;
	useEffect(() => {
		if (openId && live.data?.task.id === openId) setFeedTaskKnown(openId);
	}, [openId, live.data]);

	// Old links named a task: send them to its repo.
	useEffect(() => {
		if (route.page !== "task" || !summaries.data) return;
		const found = summaries.data.tasks.find((t) => t.id === route.taskId);
		if (found) window.location.replace(href.repo(found.repo));
	}, [route, summaries.data]);

	const onChanged = useCallback(() => {
		live.refresh();
		history.refresh();
		leader.refresh();
		summaries.refresh();
	}, [history, leader, live, summaries]);

	const openRepo = useCallback(
		async (repo: string) => {
			setOpening(true);
			setOpenError(undefined);
			try {
				const result = await api.openRepo(repo);
				setOpened(result);
				summaries.refresh();
				window.location.hash = href.repo(result.repo);
			} catch (error) {
				setOpenError(error instanceof Error ? error.message : String(error));
			} finally {
				setOpening(false);
			}
		},
		[summaries],
	);

	const view: RepoView | null =
		route.page === "repo"
			? { kind: "repo", tab: route.tab, state: route.state, ...(route.path !== undefined ? { path: route.path } : {}), ...(route.ref ? { ref: route.ref } : {}) }
			: route.page === "change"
				? { kind: "change", change: route.change, tab: route.tab }
				: null;

	// Breadcrumbs and the window title.
	const crumbs: Crumb[] = [];
	let title = "Blueprint";
	if (repoName !== null) {
		crumbs.push({ label: "Repositories", href: href.repos() }, { label: repoName, href: href.repo(repoName, "changes", base) });
		title = `${repoName} · Blueprint`;
		if (route.page === "change") {
			const change = task ? changesOf(task).find((c) => c.id === route.change) : undefined;
			const claim = !task ? snapshot.data?.claims.find((c) => c.change === route.change) : undefined;
			const ended = !task && !claim ? freeChange.data?.claim?.intent?.split("\n")[0].trim() : undefined;
			const label = change?.title || (claim ? claimTitle(claim) : ended || route.change);
			crumbs.push({ label });
			title = `${label} · ${repoName} · Blueprint`;
		}
	} else if (onRepos) title = "Repositories · Blueprint";
	else if (route.page === "inbox") {
		crumbs.push({ label: "Inbox" });
		title = `Inbox${inbox.count ? ` (${inbox.count})` : ""} · Blueprint`;
	}
	useEffect(() => {
		document.title = title;
	}, [title]);

	const errors = [
		summaries.error && `Repositories: ${summaries.error}`,
		free.error && `Coordinator-free repos: ${free.error}`,
		task && live.error && `Live status: ${live.error}`,
		snapshot.error && `${repoName}: ${snapshot.error}`,
	].filter((error): error is string => !!error);

	let page;
	if (route.page === "inbox") {
		page = <InboxPage groups={inbox.groups} loaded={summaries.loaded} error={summaries.error} />;
	} else if (route.page === "repos") {
		page = (
			<RepoList
				rows={summaries.data ? buildRepoRows(summaries.data) : []}
				loaded={summaries.loaded}
				allRepos={allRepos.data ?? []}
				opening={opening}
				openError={openError}
				onOpenRepo={(repo) => void openRepo(repo)}
			/>
		);
	} else if (repoName !== null && view) {
		if (task) {
			page = (
				<ElectedRepoPage
					repo={repoName}
					base={base}
					view={view}
					task={task}
					live={live.data}
					history={history.data ?? (history.error ? null : undefined)}
					leader={leader.data}
					liveStatus={liveStatus}
					api={api}
					onChanged={onChanged}
				/>
			);
		} else if (isFree && snapshot.data) {
			page = (
				<FreeRepoPage
					repo={repoName}
					base={base}
					view={view}
					snapshot={{ ...snapshot.data, audit: audit.data }}
					changeHistory={freeChange.data ?? (freeChange.error ? null : undefined)}
					liveStatus={liveStatus}
					api={api}
				/>
			);
		} else if ((isFree && !snapshot.error) || !free.loaded || (!isFree && !live.loaded)) {
			page = <Loading what={repoName} />;
		} else {
			page = (
				<main className="page" id="main">
					<div className="box empty">
						<h2>{repoName} isn't open for agents</h2>
						<p>
							{isFree ? snapshot.error : "No agents are working on a repo by this name."} <a href={href.repos()}>Back to Repositories</a>.
						</p>
					</div>
				</main>
			);
		}
	} else if (route.page === "task") {
		page = summaries.loaded && !summaries.data?.tasks.some((t) => t.id === route.taskId) ? (
			<main className="page" id="main">
				<div className="box empty">
					<h2>That link is out of date</h2>
					<p>
						It points to something that no longer exists. <a href={href.repos()}>See all repositories</a>.
					</p>
				</div>
			</main>
		) : (
			<Loading what="repo" />
		);
	} else {
		page = (
			<main className="page" id="main">
				<div className="box empty">
					<h2>Page not found</h2>
					<p>
						<a href={href.repos()}>Go to Repositories</a>.
					</p>
				</div>
			</main>
		);
	}

	return (
		<div className="shell">
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<TopBar crumbs={crumbs} inboxCount={inbox.count} inboxCurrent={route.page === "inbox"} />
			{errors.length > 0 ? (
				<div className="page-errors" role="alert">
					<div className="page-errors__inner">
						<strong>Some data couldn't be refreshed.</strong> <span>{errors.join(" · ")}</span>
					</div>
				</div>
			) : null}
			<PageBoundary key={routePlace(route)}>{page}</PageBoundary>
		</div>
	);
}
