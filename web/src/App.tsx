import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { InboxPage } from "./components/InboxPage";
import { PageBoundary } from "./components/PageBoundary";
import { RepoList } from "./components/RepoList";
import { RepoPage, type RepoView } from "./components/RepoPage";
import { TopBar, type Crumb } from "./components/TopBar";
import { useLiveFeed } from "./hooks/useLiveFeed";
import { usePoll } from "./hooks/usePoll";
import { claimTitle } from "./lib/claimStatus";
import { buildInbox } from "./lib/inbox";
import { buildRepoRows } from "./lib/repos";
import { href, parseRoute, type Route } from "./lib/routes";
import "./App.css";

/** Where a route points, ignoring tabs: moving to a different place scrolls to the top; switching tabs doesn't. */
export function routePlace(route: Route): string {
	if (route.page === "repo") return `repo:${route.repo}`;
	if (route.page === "change") return `change:${route.repo}:${route.change}`;
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

export function App() {
	const route = useHashRoute();
	const onRepos = route.page === "repos";
	const repoName = route.page === "repo" || route.page === "change" ? route.repo : null;

	// Every repo's counts in one read: the Repositories list, and the Inbox count on every page.
	const summaries = usePoll("summaries", api.summaries, onRepos || route.page === "inbox" ? 15_000 : 30_000);
	const inbox = buildInbox(summaries.data);

	// The repo's live feed: while it's connected, a ping triggers each refresh and polling slows to a safety net.
	const feedKey = repoName !== null ? `repo:${repoName}` : null;
	const refreshers = useRef<(() => void)[]>([]);
	const liveStatus = useLiveFeed(feedKey, () => refreshers.current.forEach((refresh) => refresh()));
	const every = (ms: number) => (liveStatus === "live" ? 30_000 : ms);

	const snapshot = usePoll(repoName !== null ? `repo:${repoName}` : null, () => api.snapshot(repoName!), every(5_000));
	// The audit replays every record in Git, so it loads on its own and less often.
	const audit = usePoll(repoName !== null ? `audit:${repoName}` : null, () => api.audit(repoName!), 60_000);
	const changeId = route.page === "change" ? route.change : null;
	const change = usePoll(changeId ? `change:${repoName}:${changeId}` : null, () => api.change(repoName!, changeId!), every(10_000));
	refreshers.current = [snapshot.refresh, audit.refresh, change.refresh];

	const view: RepoView | null =
		route.page === "repo"
			? { kind: "repo", tab: route.tab, ...(route.path !== undefined ? { path: route.path } : {}), ...(route.ref ? { ref: route.ref } : {}) }
			: route.page === "change"
				? { kind: "change", change: route.change, tab: route.tab }
				: null;

	// Breadcrumbs and the window title.
	const crumbs: Crumb[] = [];
	let title = "GitHive";
	if (repoName !== null) {
		crumbs.push({ label: "Repositories", href: href.repos() }, { label: repoName, href: href.repo(repoName) });
		title = `${repoName} · GitHive`;
		if (route.page === "change") {
			const claim = snapshot.data?.claims.find((c) => c.change === route.change);
			const ended = !claim ? change.data?.claim?.intent?.split("\n")[0].trim() : undefined;
			const label = claim ? claimTitle(claim) : ended || route.change;
			crumbs.push({ label });
			title = `${label} · ${repoName} · GitHive`;
		}
	} else if (onRepos) title = "Repositories · GitHive";
	else if (route.page === "inbox") {
		crumbs.push({ label: "Inbox" });
		title = `Inbox${inbox.count ? ` (${inbox.count})` : ""} · GitHive`;
	}
	useEffect(() => {
		document.title = title;
	}, [title]);

	const errors = [summaries.error && `Repositories: ${summaries.error}`, snapshot.data && snapshot.error && `${repoName}: ${snapshot.error}`].filter((error): error is string => !!error);

	let page;
	if (route.page === "inbox") {
		page = <InboxPage groups={inbox.groups} loaded={summaries.loaded} error={summaries.error} />;
	} else if (route.page === "repos") {
		page = <RepoList rows={summaries.data ? buildRepoRows(summaries.data) : []} loaded={summaries.loaded} />;
	} else if (repoName !== null && view) {
		if (snapshot.data) {
			page = (
				<RepoPage
					repo={repoName}
					view={view}
					snapshot={{ ...snapshot.data, audit: audit.data }}
					changeHistory={change.data ?? (change.error ? null : undefined)}
					liveStatus={liveStatus}
					api={api}
				/>
			);
		} else if (!snapshot.error) {
			page = <Loading what={repoName} />;
		} else {
			page = (
				<main className="page" id="main">
					<div className="box empty">
						<h2>{repoName} isn't open for agents</h2>
						<p>
							{snapshot.error} <a href={href.repos()}>Back to Repositories</a>.
						</p>
					</div>
				</main>
			);
		}
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
