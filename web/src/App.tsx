import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { messageOf } from "./lib/errors";
import {
	SIGNED_OUT_EVENT,
	SIGNED_OUT_MESSAGE,
	account,
	admin,
	api,
	type ChangeHistory,
	demo,
	type LandingStretch,
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
import { EmptyPage, Shell, SkipLink } from "./components/Page";
import { PageBoundary } from "./components/PageBoundary";
import { SignIn } from "./components/SignIn";
import { RepoList } from "./components/RepoList";
import { RepoPage, type RepoView } from "./components/RepoPage";
import { TopBar, type Crumb } from "./components/TopBar";
import { Collapse } from "./components/ui/collapse";
import { useChanged } from "./hooks/useChanged";
import { replaceHash, routePlace, useHashRoute } from "./hooks/useHashRoute";
import { useLingering } from "./hooks/useLingering";
import { useLiveFeed } from "./hooks/useLiveFeed";
import { usePoll } from "./hooks/usePoll";
import { claimTitle } from "./lib/claimStatus";
import { buildInbox } from "./lib/inbox";
import { buildRepoRows } from "./lib/repos";
import { href, type RepoTab, type Route } from "./lib/routes";
import { type Provider, inviteOf, signinErrorMessage, signinErrorOf, withoutSigninError } from "./lib/session";
import { cn } from "./lib/utils";

/** What couldn't be refreshed, in a bar under the top bar: it folds open, and folds away once all is well again. */
function PageErrors({ errors }: { errors: string[] }) {
	const said = errors.join(" · ");
	// While the bar folds away, it still says what it said.
	const [shown, setShown] = useState(said);
	if (said && said !== shown) setShown(said);
	// As long as the fold takes (--motion-slow).
	const lingering = useLingering(!!said, 400);
	return (
		<Collapse open={!!said}>
			{lingering ? (
				<div className="border-b border-bad/35 bg-bad-soft text-ui text-bad" role="alert">
					<div className="mx-auto max-w-(--page-width) px-6 py-2 wrap-anywhere to-560:px-4">
						<strong>Some data couldn't be refreshed.</strong> <span>{shown}</span>
					</div>
				</div>
			) : null}
		</Collapse>
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
	const [takesInviteCode, setTakesInviteCode] = useState(false);
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
			(answer) => {
				setProviders(answer.providers);
				setTakesInviteCode(!!answer.inviteCode);
			},
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
			<EmptyPage role="alert" title="GitHive didn't answer">
				<p>{bootError}. Reload the page to try again.</p>
			</EmptyPage>
		);
	}
	if (me === null) {
		const signIn = { providers, error: signinError, takesInviteCode, invite: inviteOf(window.location.search) };
		return <SignedOut signIn={signIn} />;
	}
	return <Dashboard me={me} onSignOut={signOut} />;
}

/** Someone signed out: a public repo's pages when the address names one, and the sign-in screen otherwise. */
function SignedOut({ signIn: options }: { signIn: Omit<ComponentProps<typeof SignIn>, "hash"> }) {
	const route = useHashRoute();
	const [signingIn, setSigningIn] = useState(false);
	const signIn = <SignIn {...options} hash={window.location.hash} />;
	const error = options.error;
	const reading = route.page === "repo" || route.page === "change";
	// After a failed sign-in, or once they ask to sign in, the sign-in screen.
	const toSignIn = signingIn || !!error;
	if (!reading || toSignIn) return signIn;
	return <Visitor route={route} onSignIn={() => setSigningIn(true)} signIn={signIn} />;
}

/** A public repo, read by someone signed out. A repo they can't read asks them to sign in. */
function Visitor({
	route,
	onSignIn,
	signIn,
}: {
	route: Extract<Route, { page: "repo" | "change" }>;
	onSignIn: () => void;
	signIn: ReactNode;
}) {
	const changeId = route.page === "change" ? route.change : null;
	const data = useRepoData(route.repo, changeId);
	const changeLabel = changeId ? changeTitle(changeId, data.snapshot.data, data.change.data) : "";
	const { crumbs, title } = headingOf(route, 0, changeLabel);
	useEffect(() => {
		document.title = title;
	}, [title]);
	const view = repoViewOf(route);
	if (data.snapshot.error === SIGNED_OUT_MESSAGE) return signIn;
	// The Repositories list is for people signed in, so the trail starts at the repo.
	const trail = crumbs.filter((crumb) => crumb.href !== href.repos());
	return (
		<Shell>
			<SkipLink />
			<TopBar crumbs={trail} onSignIn={onSignIn} />
			<PageBoundary key={routePlace(route)}>
				{view ? <RepoRoute repo={route.repo} view={view} data={data} visitor /> : <PageNotFound />}
			</PageBoundary>
		</Shell>
	);
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

	// A repo's audit and access count once its page shows (before that, the page says what's wrong), and the Audit
	// tab says itself why it has no audit to show.
	const auditTab = route.page === "repo" && route.tab === "audit" && !audit.data;
	const errors = [
		summaries.error && `Repositories: ${summaries.error}`,
		snapshot.data && snapshot.error && `${repoName}: ${snapshot.error}`,
		snapshot.data && !auditTab && audit.error && `${repoName} audit: ${audit.error}`,
		snapshot.data && access.error && `${repoName} access: ${access.error}`,
	].filter((error): error is string => !!error);

	const view = repoViewOf(route);
	const lastStretch = summaries.data?.repos.find((row) => row.repo === repoName)?.summary?.lastStretch;
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
				query={route.q ?? ""}
				onQueryChange={(q) => replaceHash(href.repos(q))}
				canCreate={me.kind === "user"}
				{...(me.kind === "user" ? { demo } : {})}
			/>
		);
	} else if (repoName !== null && view) {
		page = (
			<RepoRoute
				repo={repoName}
				view={view}
				data={{ liveStatus, snapshot, audit, access, change }}
				refreshSummaries={summaries.refresh}
				{...(lastStretch ? { lastStretch } : {})}
			/>
		);
	} else {
		page = <PageNotFound />;
	}

	return (
		<Shell>
			<SkipLink />
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
			<PageErrors errors={errors} />
			<PageBoundary key={routePlace(route)}>{page}</PageBoundary>
		</Shell>
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
	refreshSummaries?: () => void;
	/** Read by someone signed out: nothing to manage. */
	visitor?: boolean;
	lastStretch?: LandingStretch;
}) {
	const { repo, view, refreshSummaries = () => undefined, visitor = false, lastStretch } = props;
	const { liveStatus, snapshot, audit, access, change } = props.data;
	// GitHive hasn't started on this repo yet. It still shows its code, its settings and a way to start.
	const notStarted = !snapshot.data && !!snapshot.error && !/^no repo /.test(snapshot.error);
	const ready = !!snapshot.data || notStarted;
	// While it loads, the page shows its header and tabs from the address, and its content takes the place of
	// "Loading…" under them; a repo that can't be shown fades in in its place.
	const phase = ready || !snapshot.error ? "page" : "unavailable";
	const swapped = useChanged(phase);
	let shown: ReactNode;
	if (phase === "page") {
		shown = (
			<RepoPage
				repo={repo}
				view={view}
				loading={!ready}
				snapshot={snapshot.data ? { ...snapshot.data, audit: audit.data } : null}
				onStarted={() => {
					snapshot.refresh();
					refreshSummaries();
				}}
				onSettingsChanged={() => snapshot.refresh()}
				changeHistory={change.data ?? (change.error ? null : undefined)}
				auditError={audit.error}
				onAuditRetry={audit.refresh}
				liveStatus={liveStatus}
				{...(lastStretch ? { lastStretch } : {})}
				api={api}
				{...(access.data ? { access: access.data } : {})}
				{...(visitor ? {} : { manage })}
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
	} else {
		shown = <RepoUnavailable repo={repo} error={snapshot.error!} />;
	}
	return (
		<div key={phase} className={cn("flex flex-1 flex-col", swapped && "animate-fade")}>
			{shown}
		</div>
	);
}

/** What the repo page shows for a route, or null when the route isn't a repo's. */
function repoViewOf(route: Route): RepoView | null {
	if (route.page === "change")
		return { kind: "change", change: route.change, tab: route.tab, ...(route.decide ? { decide: true } : {}) };
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

/**
 * The breadcrumbs and the window title for a route. The title names the page, the most particular first, after how
 * many changes wait on the reader.
 */
export function headingOf(route: Route, inboxCount: number, changeLabel: string): { crumbs: Crumb[]; title: string } {
	const { crumbs, title } = placeOf(route, changeLabel);
	const waiting = inboxCount > 0 ? `(${inboxCount}) ` : "";
	return { crumbs, title: `${waiting}${title} · GitHive` };
}

function placeOf(route: Route, changeLabel: string): { crumbs: Crumb[]; title: string } {
	switch (route.page) {
		case "repo":
		case "change": {
			const repoName = route.repo;
			const crumbs: Crumb[] = [
				{ label: "Repositories", href: href.repos() },
				{ label: repoName, href: href.repo(repoName) },
			];
			if (route.page !== "change") return { crumbs, title: [...tabTitle(route), repoName].join(" · ") };
			crumbs.push({ label: changeLabel });
			return { crumbs, title: `${changeLabel} · ${repoName}` };
		}
		case "repos":
			return { crumbs: [], title: "Repositories" };
		case "inbox":
			return { crumbs: [{ label: "Inbox" }], title: "Inbox" };
		case "agents-settings":
			return { crumbs: [{ label: "Agents" }], title: "Agents" };
		case "admin":
			return { crumbs: [{ label: "Admin" }], title: "Admin" };
		case "new-repo":
			return {
				crumbs: [{ label: "Repositories", href: href.repos() }, { label: "New repository" }],
				title: "New repository",
			};
		case "orgs":
			return { crumbs: [{ label: "Your organizations" }], title: "Your organizations" };
		case "org":
			return {
				crumbs: [{ label: "Your organizations", href: href.orgs() }, { label: route.org }],
				title: route.org,
			};
		case "not-found":
			return { crumbs: [], title: "Page not found" };
	}
}

const TAB_TITLES: Record<Exclude<RepoTab, "hive">, string> = {
	changes: "Changes",
	history: "History",
	claims: "Claims",
	code: "Code",
	agents: "Agents",
	audit: "Audit",
	settings: "Settings",
};

/**
 * What a repo tab puts before the repo's name in the title: in Code, the file and its folder; on the Hive, the repo's
 * own page, nothing.
 */
function tabTitle(route: Extract<Route, { page: "repo" }>): string[] {
	if (route.tab === "hive") return [];
	const parts = route.tab === "code" ? (route.path ?? "").split("/").filter(Boolean) : [];
	const name = parts.pop();
	if (!name) return [TAB_TITLES[route.tab]];
	return parts.length ? [name, parts.join("/")] : [name];
}

/** For pages that belong to a person signed in to GitHive, not an Access caller. */
function ForPeople({ what }: { what: string }) {
	return (
		<EmptyPage title={`${what} belong to people signed in to GitHive`}>
			<p>
				Through Cloudflare Access you see every repository, but have no namespace or organizations of your own.{" "}
				<a href={href.repos()}>Back to Repositories</a>.
			</p>
		</EmptyPage>
	);
}

function NotAnOperator() {
	return (
		<EmptyPage title="Admin is for GitHive's operators">
			<p>
				It's reached through Cloudflare Access, on GitHive's admin address.{" "}
				<a href={href.repos()}>Back to Repositories</a>.
			</p>
		</EmptyPage>
	);
}

function NoAgentsHere() {
	return (
		<EmptyPage title="Agents belong to people signed in to GitHive">
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
		<EmptyPage title={heading}>
			<p>
				{reason} <a href={href.repos()}>Back to Repositories</a>.
			</p>
		</EmptyPage>
	);
}

function PageNotFound() {
	return (
		<EmptyPage title="Page not found">
			<p>
				<a href={href.repos()}>Go to Repositories</a>.
			</p>
		</EmptyPage>
	);
}
