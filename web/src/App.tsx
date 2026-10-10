import { type ReactNode, useEffect, useRef, useState } from "react";
import { messageOf } from "./lib/errors";
import {
	SIGNED_OUT_EVENT,
	account,
	admin,
	api,
	type ChangeHistory,
	fetchMe,
	manage,
	type Me,
	type RepoSnapshot,
} from "./api";
import { AdminPage } from "./components/AdminPage";
import { AgentsPage } from "./components/AgentsPage";
import { InboxPage } from "./components/InboxPage";
import { NewRepoPage } from "./components/NewRepoPage";
import { OrgPage } from "./components/OrgPage";
import { OrgsPage } from "./components/OrgsPage";
import { PageBoundary } from "./components/PageBoundary";
import { SignIn } from "./components/SignIn";
import { RepoList } from "./components/RepoList";
import { RepoPage, type RepoView } from "./components/RepoPage";
import { TopBar, type Crumb } from "./components/TopBar";
import { useLiveFeed } from "./hooks/useLiveFeed";
import { usePoll } from "./hooks/usePoll";
import { claimTitle } from "./lib/claimStatus";
import { buildInbox } from "./lib/inbox";
import { buildRepoRows } from "./lib/repos";
import { href, parseRoute, type Route } from "./lib/routes";
import { type Provider, signinErrorMessage, signinErrorOf, withoutSigninError } from "./lib/session";
import "./App.css";

/** Where a route points, ignoring tabs. Moving to a new place scrolls to the top; switching tabs doesn't. */
export function routePlace(route: Route): string {
	if (route.page === "repo") return `repo:${route.repo}`;
	if (route.page === "change") return `change:${route.repo}:${route.change}`;
	if (route.page === "org") return `org:${route.org}`;
	return route.page;
}

// Moving between files in the Code tab scrolls to the top too, without remounting the page.
function scrollPlace(route: Route): string {
	const inCode = route.page === "repo" && route.tab === "code";
	const codePlace = inCode ? `:code:${route.path ?? ""}:${route.ref ?? ""}` : "";
	return `${routePlace(route)}${codePlace}`;
}

export function useHashRoute(): Route {
	const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
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

/** A page with nothing to show but a message. */
function EmptyPage({ role, children }: { role?: "alert"; children: ReactNode }) {
	return (
		<main className="page" id="main">
			<div className="box empty" role={role}>
				{children}
			</div>
		</main>
	);
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

/**
 * The dashboard: who is looking first. Nobody signed in sees the sign-in
 * screen (with why the last sign-in failed, if it did); a session that ends
 * while the page is open brings it back.
 */
export function App() {
	const [me, setMe] = useState<Me | null | undefined>(undefined);
	const [bootError, setBootError] = useState<string | null>(null);
	const [providers, setProviders] = useState<Provider[] | undefined>(undefined);
	// Read once, then dropped from the address bar so a reload doesn't show it again.
	const [signinError] = useState(() => signinErrorMessage(signinErrorOf(window.location.search)));
	useEffect(() => {
		if (signinErrorOf(window.location.search))
			window.history.replaceState(null, "", withoutSigninError(window.location.href));
	}, []);
	useEffect(() => {
		const failed = (err: unknown) => setBootError(messageOf(err));
		fetchMe().then(setMe, failed);
		const signedOut = () => setMe(null);
		window.addEventListener(SIGNED_OUT_EVENT, signedOut);
		return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
	}, []);
	useEffect(() => {
		if (me !== null || providers !== undefined) return;
		document.title = "Sign in · GitHive";
		account.providers().then(
			(answer) => setProviders(answer.providers),
			() => setProviders([]),
		);
	}, [me, providers]);
	const signOut = async () => {
		await account.signOut().catch(() => undefined);
		window.location.assign("/");
	};

	if (me === undefined) {
		if (!bootError) return null;
		return (
			<EmptyPage role="alert">
				<h2>GitHive didn't answer</h2>
				<p>{bootError}. Reload the page to try again.</p>
			</EmptyPage>
		);
	}
	if (me === null) return <SignIn providers={providers} error={signinError} hash={window.location.hash} />;
	return <Dashboard me={me} onSignOut={signOut} />;
}

/** Everything a signed-in person (or an Access caller) sees. */
export function Dashboard({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
	const route = useHashRoute();
	const onRepos = route.page === "repos";
	const repoName = route.page === "repo" || route.page === "change" ? route.repo : null;

	// Every repo's counts in one read, for the Repositories list and the Inbox count on every page.
	const summaries = usePoll("summaries", api.summaries, onRepos || route.page === "inbox" ? 15_000 : 30_000);
	// For GitHive's operators (Access): orgs' requests waiting for approval, counted on the Admin link.
	const adminRequests = usePoll(me.kind === "access" ? "admin:requests:count" : null, admin.requests, 60_000);
	const inbox = buildInbox(summaries.data);

	const changeId = route.page === "change" ? route.change : null;
	const { liveStatus, snapshot, audit, access, change } = useRepoData(repoName, changeId);

	const changeLabel = changeId ? changeTitle(changeId, snapshot.data, change.data) : "";
	const { crumbs, title } = headingOf(route, inbox.count, changeLabel);
	useEffect(() => {
		document.title = title;
	}, [title]);

	const errors = [
		summaries.error && `Repositories: ${summaries.error}`,
		snapshot.data && snapshot.error && `${repoName}: ${snapshot.error}`,
	].filter((error): error is string => !!error);

	const view = repoViewOf(route);
	let page;
	if (route.page === "admin") {
		page = me.kind === "access" ? <AdminPage admin={admin} /> : <NotAnOperator />;
	} else if (route.page === "new-repo") {
		const owner = route.owner ? { owner: route.owner } : {};
		page = me.kind === "user" ? <NewRepoPage manage={manage} {...owner} /> : <ForPeople what="New repositories" />;
	} else if (route.page === "orgs") {
		page = me.kind === "user" ? <OrgsPage me={me} manage={manage} /> : <ForPeople what="Organizations" />;
	} else if (route.page === "org") {
		page = <OrgPage slug={route.org} me={me.kind === "user" ? me : { handle: "" }} manage={manage} />;
	} else if (route.page === "agents-settings") {
		page = me.kind === "user" ? <AgentsPage me={me} account={account} /> : <NoAgentsHere />;
	} else if (route.page === "inbox") {
		page = <InboxPage groups={inbox.groups} loaded={summaries.loaded} error={summaries.error} />;
	} else if (route.page === "repos") {
		page = (
			<RepoList
				rows={summaries.data ? buildRepoRows(summaries.data) : []}
				loaded={summaries.loaded}
				canCreate={me.kind === "user"}
			/>
		);
	} else if (repoName !== null && view) {
		page = (
			<RepoRoute
				repo={repoName}
				view={view}
				data={{ liveStatus, snapshot, audit, access, change }}
				refreshSummaries={summaries.refresh}
			/>
		);
	} else {
		page = <PageNotFound />;
	}

	return (
		<div className="shell">
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<TopBar
				crumbs={crumbs}
				inboxCount={inbox.count}
				inboxCurrent={route.page === "inbox"}
				me={me}
				onSignOut={onSignOut}
				agentsCurrent={route.page === "agents-settings"}
				adminCurrent={route.page === "admin"}
				{...(adminRequests.data ? { adminRequests: adminRequests.data.length } : {})}
				orgsCurrent={route.page === "orgs" || route.page === "org"}
			/>
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

/**
 * A repo's data for its page: its snapshot, audit, the reader's access, and the change shown, if any. While the
 * repo's live feed is connected, each ping refreshes them and polling slows to a safety net.
 */
function useRepoData(repoName: string | null, changeId: string | null) {
	const feedKey = repoName;
	const refreshers = useRef<(() => void)[]>([]);
	const liveStatus = useLiveFeed(feedKey, () => refreshers.current.forEach((refresh) => refresh()));
	const every = (intervalMs: number) => (liveStatus === "live" ? 30_000 : intervalMs);

	const snapshot = usePoll(repoName !== null ? `repo:${repoName}` : null, () => api.snapshot(repoName!), every(5_000));
	// The audit replays every record in Git, so it loads on its own and less often.
	const audit = usePoll(repoName !== null ? `audit:${repoName}` : null, () => api.audit(repoName!), 60_000);
	// What the reader may do here decides the vote form and which settings they can change.
	const access = usePoll(repoName !== null ? `access:${repoName}` : null, () => api.access(repoName!), 60_000);
	const change = usePoll(
		changeId ? `change:${repoName}:${changeId}` : null,
		() => api.change(repoName!, changeId!),
		every(10_000),
	);
	refreshers.current = [snapshot.refresh, audit.refresh, change.refresh];
	return { liveStatus, snapshot, audit, access, change };
}

/** A repo's page, once its snapshot is read; or that it's loading, or why it can't be shown. */
function RepoRoute(props: {
	repo: string;
	view: RepoView;
	data: ReturnType<typeof useRepoData>;
	refreshSummaries: () => void;
}) {
	const { repo, view, refreshSummaries } = props;
	const { liveStatus, snapshot, audit, access, change } = props.data;
	// GitHive hasn't started on this repo yet. It still shows its code, its settings and a way to start.
	const notStarted = !snapshot.data && !!snapshot.error && !/^no repo /.test(snapshot.error);
	if (snapshot.data || notStarted) {
		return (
			<RepoPage
				repo={repo}
				view={view}
				snapshot={snapshot.data ? { ...snapshot.data, audit: audit.data } : null}
				onStarted={() => {
					snapshot.refresh();
					refreshSummaries();
				}}
				onSettingsChanged={() => snapshot.refresh()}
				changeHistory={change.data ?? (change.error ? null : undefined)}
				liveStatus={liveStatus}
				api={api}
				{...(access.data ? { access: access.data } : {})}
				manage={manage}
				onAccessChanged={() => {
					access.refresh();
					refreshSummaries();
				}}
				onDeleted={() => {
					refreshSummaries();
					window.location.hash = href.repos();
				}}
			/>
		);
	}
	if (!snapshot.error) return <Loading what={repo} />;
	return <RepoUnavailable repo={repo} error={snapshot.error} />;
}

/** What the repo page shows for a route, or null when the route isn't a repo's. */
function repoViewOf(route: Route): RepoView | null {
	if (route.page === "change") return { kind: "change", change: route.change, tab: route.tab };
	if (route.page !== "repo") return null;
	return {
		kind: "repo",
		tab: route.tab,
		...(route.path !== undefined ? { path: route.path } : {}),
		...(route.ref ? { ref: route.ref } : {}),
		...(route.branch ? { branch: route.branch } : {}),
	};
}

/** A change's name in the breadcrumbs: its claim's title, else what it set out to do once it ended, else its id. */
function changeTitle(changeId: string, snapshot: RepoSnapshot | undefined, history: ChangeHistory | undefined): string {
	const claim = snapshot?.claims.find((candidate) => candidate.change === changeId);
	if (claim) return claimTitle(claim);
	const ended = history?.claim?.intent?.split("\n")[0]?.trim();
	return ended || changeId;
}

/** The breadcrumbs and the window title for a route. */
function headingOf(route: Route, inboxCount: number, changeLabel: string): { crumbs: Crumb[]; title: string } {
	switch (route.page) {
		case "repo":
		case "change": {
			const repoName = route.repo;
			const crumbs: Crumb[] = [
				{ label: "Repositories", href: href.repos() },
				{ label: repoName, href: href.repo(repoName) },
			];
			if (route.page !== "change") return { crumbs, title: `${repoName} · GitHive` };
			crumbs.push({ label: changeLabel });
			return { crumbs, title: `${changeLabel} · ${repoName} · GitHive` };
		}
		case "repos":
			return { crumbs: [], title: "Repositories · GitHive" };
		case "inbox": {
			const count = inboxCount ? ` (${inboxCount})` : "";
			return { crumbs: [{ label: "Inbox" }], title: `Inbox${count} · GitHive` };
		}
		case "agents-settings":
			return { crumbs: [{ label: "Agents" }], title: "Agents · GitHive" };
		case "admin":
			return { crumbs: [{ label: "Admin" }], title: "Admin · GitHive" };
		case "new-repo":
			return {
				crumbs: [{ label: "Repositories", href: href.repos() }, { label: "New repository" }],
				title: "New repository · GitHive",
			};
		case "orgs":
			return { crumbs: [{ label: "Your organizations" }], title: "Your organizations · GitHive" };
		case "org":
			return {
				crumbs: [{ label: "Your organizations", href: href.orgs() }, { label: route.org }],
				title: `${route.org} · GitHive`,
			};
		default:
			return { crumbs: [], title: "GitHive" };
	}
}

/** For pages that belong to a person signed in to GitHive, not an Access caller. */
function ForPeople({ what }: { what: string }) {
	return (
		<EmptyPage>
			<h2>{what} belong to people signed in to GitHive</h2>
			<p>
				Through Cloudflare Access you see every repository, but have no namespace or organizations of your own.{" "}
				<a href={href.repos()}>Back to Repositories</a>.
			</p>
		</EmptyPage>
	);
}

function NotAnOperator() {
	return (
		<EmptyPage>
			<h2>Admin is for GitHive's operators</h2>
			<p>
				It's reached through Cloudflare Access, on GitHive's admin address.{" "}
				<a href={href.repos()}>Back to Repositories</a>.
			</p>
		</EmptyPage>
	);
}

function NoAgentsHere() {
	return (
		<EmptyPage>
			<h2>Agents belong to people signed in to GitHive</h2>
			<p>
				Through Cloudflare Access there are no agents of your own. Sign in to GitHive on its own address to make some.{" "}
				<a href={href.repos()}>Back to Repositories</a>.
			</p>
		</EmptyPage>
	);
}

/** A repo that couldn't be read: one the reader can't see, or one GitHive can't open. */
function RepoUnavailable({ repo, error }: { repo: string; error: string }) {
	const hidden = /^no repo /.test(error);
	const heading = hidden ? `There's no ${repo} you can see` : `${repo} isn't open for agents yet`;
	const reason = hidden ? "It doesn't exist, or you aren't one of the people who can see it." : error;
	return (
		<EmptyPage>
			<h2>{heading}</h2>
			<p>
				{reason} <a href={href.repos()}>Back to Repositories</a>.
			</p>
		</EmptyPage>
	);
}

function PageNotFound() {
	return (
		<EmptyPage>
			<h2>Page not found</h2>
			<p>
				<a href={href.repos()}>Go to Repositories</a>.
			</p>
		</EmptyPage>
	);
}
