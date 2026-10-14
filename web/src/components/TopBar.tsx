import { useEffect, useState } from "react";
import type { Me } from "../api";
import { useChanged } from "../hooks/useChanged";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { HiveMark } from "./HiveMark";
import { Icon } from "./Icon";
import { ThemeChoices, ThemeMenu } from "./ThemeMenu";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export interface Crumb {
	label: string;
	href?: string;
	/** A repo's crumb (its name): it opens a switcher to the reader's other repos, when the bar has them. */
	repo?: string;
}

// The bar's links to Inbox, Agents and Admin: round-ended pills, as tall as the theme and user menus beside them, and
// like them 44px to a finger on a touch screen.
const pill = cn(
	"touch-target inline-flex shrink-0 items-center gap-1.5 rounded-full border border-input px-2.5 py-1",
	"text-ui font-medium text-foreground transition-colors duration-fast hover:bg-surface-2 hover:no-underline",
	"aria-[current=page]:border-link aria-[current=page]:text-link",
);

// The user menu's choices. Sign out keeps the 20px line it had as a button.
const menuItem =
	"rounded-md px-2.5 py-1.75 text-ui-lg font-medium text-foreground hover:no-underline aria-[current=page]:text-link";

/**
 * A signed-in person's menu: their face or initial and handle, their organizations, their agents, the keyboard's
 * shortcuts and signing out; on a phone, light or dark too, to make room in the bar.
 */
export function UserMenu({
	me,
	onSignOut,
	agentsCurrent = false,
	orgsCurrent = false,
	onShortcuts,
}: {
	me: Extract<Me, { kind: "user" }>;
	onSignOut: () => void;
	agentsCurrent?: boolean;
	orgsCurrent?: boolean;
	/** Shows the keyboard's shortcuts. */
	onShortcuts?: () => void;
}) {
	const initial = (me.name || me.handle).trim().charAt(0).toUpperCase() || "?";
	const [open, setOpen] = useState(false);
	// It closes once a choice is made, on Escape or a click elsewhere, and when the page moves on under it.
	useEffect(() => {
		const close = () => setOpen(false);
		window.addEventListener("hashchange", close);
		return () => window.removeEventListener("hashchange", close);
	}, []);
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			{/* Named by what it shows (WCAG 2.5.3), the handle after who's signed in; the initial is a picture of it. */}
			<DropdownMenuTrigger
				className={cn(
					"touch-target inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-input bg-transparent",
					"py-0.75 pr-2.5 pl-0.75 to-560:pr-0.75",
					"[font-family:inherit] text-ui leading-[inherit] font-medium text-foreground",
					"transition-colors duration-fast hover:bg-surface-2 data-[state=open]:bg-surface-2",
				)}
			>
				{me.avatarUrl ? (
					<img
						className="size-5.5 shrink-0 rounded-full object-cover"
						src={me.avatarUrl}
						alt=""
						width={22}
						height={22}
						referrerPolicy="no-referrer"
					/>
				) : (
					<span
						className="grid size-5.5 shrink-0 place-items-center rounded-full bg-primary text-micro font-bold text-primary-foreground"
						aria-hidden="true"
					>
						{initial}
					</span>
				)}
				<span className="sr-only">Signed in as </span>
				<span className="to-560:sr-only">{me.handle}</span>
			</DropdownMenuTrigger>
			{/* At least 220px and the button's width, so a long name wraps rather than stretching it. */}
			<DropdownMenuContent
				align="end"
				className="grid w-(--radix-dropdown-menu-trigger-width) max-w-[calc(100vw-32px)] min-w-55 p-1.5"
			>
				<div className="mb-1 grid gap-0.5 border-b border-border px-2.5 pt-2 pb-2.5 text-ui wrap-anywhere">
					<strong>{me.name || me.handle}</strong>
					<span className="text-muted-foreground">{me.email}</span>
				</div>
				<DropdownMenuItem asChild className={menuItem}>
					<a href={href.orgs()} aria-current={orgsCurrent ? "page" : undefined}>
						<Icon name="repo" /> Your organizations
					</a>
				</DropdownMenuItem>
				<DropdownMenuItem asChild className={menuItem}>
					<a href={href.agents()} aria-current={agentsCurrent ? "page" : undefined}>
						<Icon name="bot" /> Agents
					</a>
				</DropdownMenuItem>
				{onShortcuts ? (
					<DropdownMenuItem className={cn(menuItem, "leading-5 to-560:hidden")} onSelect={onShortcuts}>
						<Icon name="keyboard" /> Keyboard shortcuts
					</DropdownMenuItem>
				) : null}
				{/* On a phone the bar has no room for the theme's own button: its choices are here. */}
				<div className="hidden to-560:contents">
					<DropdownMenuSeparator />
					<DropdownMenuLabel>Theme</DropdownMenuLabel>
					<ThemeChoices />
					<DropdownMenuSeparator />
				</div>
				<DropdownMenuItem className={cn(menuItem, "leading-5")} onSelect={onSignOut}>
					<Icon name="arrow" /> Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// The Inbox while something waits on the reader: filled in the color of what asks them, its edge too when it's the
// page shown.
const waiting = cn(
	"border-needs/40 bg-needs-soft text-needs hover:bg-needs-soft",
	"aria-[current=page]:border-needs aria-[current=page]:text-needs",
);

/**
 * The Inbox link, with how many things wait on the reader. It leads the bar's links, named even on a phone, by what it
 * shows (WCAG 2.5.3): "Inbox 5", then what the count is.
 */
function InboxLink({ inboxCount, inboxCurrent }: { inboxCount?: number | undefined; inboxCurrent: boolean }) {
	return (
		<a
			className={cn(pill, "ml-auto", inboxCount ? waiting : null)}
			href={href.inbox()}
			aria-current={inboxCurrent ? "page" : undefined}
		>
			<Icon name="inbox" size={14} />
			<span>Inbox</span>{" "}
			{inboxCount ? (
				<>
					<PillCount>{inboxCount}</PillCount>
					<span className="sr-only"> waiting on you</span>
				</>
			) : null}
		</a>
	);
}

/** How many wait, on a pill in the color of what needs a person; or, `quiet`, a neutral count. It bumps as it changes. */
function PillCount({ children, quiet = false }: { children: number; quiet?: boolean }) {
	const changed = useChanged(children);
	return (
		<span
			key={children}
			className={cn(
				"h-4.5 min-w-4.5 rounded-full px-1.5 text-center text-micro leading-4.5 font-bold",
				quiet ? "bg-surface-3 text-foreground" : "bg-needs text-needs-foreground",
				changed && "animate-bump",
			)}
		>
			{children}
		</span>
	);
}

/** The link to a person's own agents, where they connect one: in plain sight, not only in their menu. */
function AgentsLink({ agentsCurrent }: { agentsCurrent: boolean }) {
	return (
		<a className={pill} href={href.agents()} aria-current={agentsCurrent ? "page" : undefined} aria-label="Your agents">
			<Icon name="bot" size={14} />
			<span className="to-560:hidden">Your agents</span>
		</a>
	);
}

/**
 * A repo's crumb: its name, opening a menu of the reader's repos, most recently active first, to go to another.
 */
function RepoSwitcher({ crumb, repos, last }: { crumb: Crumb & { repo: string }; repos: string[]; last: boolean }) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const close = () => setOpen(false);
		window.addEventListener("hashchange", close);
		return () => window.removeEventListener("hashchange", close);
	}, []);
	const shown = repos.includes(crumb.repo) ? repos : [crumb.repo, ...repos];
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger
				className={cn(
					"inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5",
					"-mx-1 [font-family:inherit] text-[length:inherit] leading-[inherit] text-foreground",
					"transition-colors duration-fast hover:bg-surface-2 data-[state=open]:bg-surface-2",
					last && "font-semibold",
				)}
				aria-label={`${crumb.repo}: switch repository`}
			>
				<span className="truncate">{crumb.label}</span>
				<Icon name="chevron" size={14} className="shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-[min(70vh,28rem)] w-72 max-w-[calc(100vw-32px)]">
				<DropdownMenuLabel>Your repositories</DropdownMenuLabel>
				{shown.slice(0, 12).map((name) => (
					<DropdownMenuItem key={name} asChild className="text-ui-lg hover:no-underline">
						<a href={href.repo(name)} aria-current={name === crumb.repo ? "page" : undefined}>
							<Icon name="repo" className="text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
							{name === crumb.repo ? <Icon name="check" size={14} /> : null}
						</a>
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild className="text-ui-lg hover:no-underline">
					<a href={href.repos()} className="text-foreground">
						All repositories
					</a>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// A crumb on the way: everything but the last, a link, which keeps its size.
const crumbItem = "flex items-center whitespace-nowrap before:mx-2 before:text-border-strong before:content-['/']";

/**
 * Where you are: Repositories (on a wide screen), then each place on the way a link, the last one not; a repo's name
 * opens a switcher. Only the last one shortens, so the others never print under it; on a phone, only the last one:
 * the repo header and the page say the rest.
 */
function Breadcrumbs({ crumbs, repos, onRepos }: { crumbs: Crumb[]; repos?: string[]; onRepos: boolean }) {
	return (
		<nav className="min-w-0 overflow-hidden" aria-label="Breadcrumb">
			<ol className="m-0 flex min-w-0 list-none items-center p-0">
				{repos ? (
					// Home, quietly, beside the mark: the place every other one is under.
					<li className={cn(crumbItem, "shrink-0 to-720:hidden", crumbs.length ? "" : "min-w-0")}>
						<a
							className="text-muted-foreground transition-colors duration-fast hover:text-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
							href={href.repos()}
							aria-current={onRepos ? "page" : undefined}
						>
							Repositories
						</a>
					</li>
				) : null}
				{crumbs.map((crumb, index) => {
					const last = index === crumbs.length - 1;
					return (
						<li
							key={`${index}:${crumb.label}`}
							className={cn(crumbItem, last ? "min-w-0 overflow-hidden" : "shrink-0 to-560:hidden")}
						>
							{crumb.repo && repos ? (
								<RepoSwitcher crumb={{ ...crumb, repo: crumb.repo }} repos={repos} last={last} />
							) : crumb.href && !last ? (
								<a className="text-foreground" href={crumb.href}>
									{crumb.label}
								</a>
							) : (
								<span
									className={cn(last && "overflow-hidden font-semibold text-ellipsis")}
									aria-current={last ? "page" : undefined}
								>
									{crumb.label}
								</span>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

/**
 * The top bar: the GitHive mark, which leads home, where you are, the Inbox, your agents, light or dark, and who you
 * are. It's drawn --bar-height tall, so what sticks under it knows where to start.
 */
export function TopBar({
	crumbs,
	repos,
	onRepos = false,
	onShortcuts,
	inboxCount,
	inboxCurrent = false,
	me,
	onSignOut,
	agentsCurrent = false,
	orgsCurrent = false,
	adminCurrent = false,
	adminRequests,
	onSignIn,
}: {
	crumbs: Crumb[];
	/** The reader's repos, most recently active first, for the repo crumb's switcher; none for someone signed out. */
	repos?: string[];
	/** On Repositories itself. */
	onRepos?: boolean;
	/** Shows the keyboard's shortcuts (from the user menu). */
	onShortcuts?: () => void;
	/** Changes waiting on a person, across repos; undefined until known. */
	inboxCount?: number;
	inboxCurrent?: boolean;
	/** Who is looking: a signed-in person gets a menu; an Access caller sees their label, quietly. */
	me?: Me;
	onSignOut?: () => void;
	agentsCurrent?: boolean;
	orgsCurrent?: boolean;
	adminCurrent?: boolean;
	/** For an Access caller: orgs' requests waiting for approval, once known. */
	adminRequests?: number;
	/** For someone signed out, reading a public repo: no inbox, and a way to sign in. */
	onSignIn?: () => void;
}) {
	return (
		<header className="sticky top-0 z-10 h-(--bar-height) border-b border-border bg-card">
			<div className="mx-auto flex h-full max-w-(--page-width) min-w-0 items-center gap-3.5 px-6 to-560:gap-2 to-560:px-4">
				<a
					className="inline-flex shrink-0 items-center gap-2 text-body font-bold text-foreground hover:no-underline"
					href="#/"
					aria-label="GitHive home"
				>
					<HiveMark />
					<span className="to-560:hidden">GitHive</span>
				</a>
				{crumbs.length > 0 || repos ? <Breadcrumbs crumbs={crumbs} repos={repos} onRepos={onRepos} /> : null}
				{onSignIn ? (
					<Button variant="primary" className="ml-auto shrink-0" onClick={onSignIn}>
						Sign in
					</Button>
				) : (
					<InboxLink inboxCount={inboxCount} inboxCurrent={inboxCurrent} />
				)}
				{me?.kind === "user" ? <AgentsLink agentsCurrent={agentsCurrent} /> : null}
				{me?.kind === "access" ? (
					<a className={pill} href={href.admin()} aria-current={adminCurrent ? "page" : undefined}>
						<Icon name="settings" size={14} />
						<span className="to-560:sr-only">Admin</span> {/* Neutral: the Inbox's is the one red number. */}
						{adminRequests ? (
							<>
								<PillCount quiet>{adminRequests}</PillCount>
								<span className="sr-only"> requests waiting</span>
							</>
						) : null}
					</a>
				) : null}
				{/* On a phone, someone signed in finds light and dark in their menu. */}
				<ThemeMenu className={me?.kind === "user" ? "to-560:hidden" : undefined} />
				{me?.kind === "user" ? (
					<UserMenu
						me={me}
						onSignOut={onSignOut ?? (() => undefined)}
						agentsCurrent={agentsCurrent}
						orgsCurrent={orgsCurrent}
						{...(onShortcuts ? { onShortcuts } : {})}
					/>
				) : null}
				{me?.kind === "access" ? (
					<span
						className="min-w-0 shrink overflow-hidden text-meta text-ellipsis whitespace-nowrap text-muted-foreground to-560:hidden"
						title="Signed in through Cloudflare Access"
					>
						{me.label}
					</span>
				) : null}
			</div>
		</header>
	);
}
