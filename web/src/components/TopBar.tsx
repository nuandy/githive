import { useEffect, useState } from "react";
import type { Me } from "../api";
import { useChanged } from "../hooks/useChanged";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { HiveMark } from "./HiveMark";
import { Icon } from "./Icon";
import { ThemeMenu } from "./ThemeMenu";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export interface Crumb {
	label: string;
	href?: string;
}

// The bar's links to Inbox, Agents and Admin: round-ended pills, as tall as the theme and user menus beside them.
const pill = cn(
	"inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1",
	"text-ui font-medium text-foreground transition-colors duration-fast hover:bg-surface-2 hover:no-underline",
	"aria-[current=page]:border-link aria-[current=page]:text-link",
);

// The user menu's choices. Sign out keeps the 20px line it had as a button.
const menuItem =
	"rounded-md px-2.5 py-1.75 text-ui-lg font-medium text-foreground hover:no-underline aria-[current=page]:text-link";

/** A signed-in person's menu: their face or initial and handle, their organizations, their agents, and signing out. */
export function UserMenu({
	me,
	onSignOut,
	agentsCurrent = false,
	orgsCurrent = false,
}: {
	me: Extract<Me, { kind: "user" }>;
	onSignOut: () => void;
	agentsCurrent?: boolean;
	orgsCurrent?: boolean;
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
			<DropdownMenuTrigger
				aria-label={`Signed in as ${me.handle}`}
				className={cn(
					"inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border bg-transparent",
					"py-0.75 pr-2.5 pl-0.75 to-560:pr-0.75",
					"[font-family:inherit] text-ui leading-[inherit] font-medium text-foreground",
					"transition-colors duration-fast hover:bg-surface-2 data-[state=open]:bg-surface-2",
					"focus-visible:border-ring focus-visible:shadow-focus focus-visible:outline-none",
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
				<span className="to-560:hidden">{me.handle}</span>
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
						<Icon name="repo" size={15} /> Your organizations
					</a>
				</DropdownMenuItem>
				<DropdownMenuItem asChild className={menuItem}>
					<a href={href.agents()} aria-current={agentsCurrent ? "page" : undefined}>
						<Icon name="bot" size={15} /> Agents
					</a>
				</DropdownMenuItem>
				<DropdownMenuItem className={cn(menuItem, "leading-5")} onSelect={onSignOut}>
					<Icon name="arrow" size={15} /> Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The Inbox link, with how many changes wait on the reader. */
function InboxLink({ inboxCount, inboxCurrent }: { inboxCount?: number | undefined; inboxCurrent: boolean }) {
	return (
		<a
			className={cn(pill, "ml-auto")}
			href="#/inbox"
			aria-current={inboxCurrent ? "page" : undefined}
			aria-label={inboxCount ? `Inbox, ${inboxCount} waiting on you` : "Inbox"}
		>
			<Icon name="alert" size={15} />
			<span className="to-560:hidden">Inbox</span>
			{inboxCount ? <PillCount>{inboxCount}</PillCount> : null}
		</a>
	);
}

/** How many wait, on a pill: white on the color of what needs a person. It bumps as the number changes. */
function PillCount({ children }: { children: number }) {
	const changed = useChanged(children);
	return (
		<span
			key={children}
			className={cn(
				"min-w-4.5 rounded-full bg-needs px-1.5 text-center text-micro leading-4.5 font-bold text-white",
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
			<Icon name="bot" size={15} />
			<span className="to-560:hidden">Agents</span>
		</a>
	);
}

/** Where you are: each place on the way a link, the last one not; on a phone, only the last two. */
function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
	return (
		<nav className="min-w-0 overflow-hidden" aria-label="Breadcrumb">
			<ol className="m-0 flex min-w-0 list-none items-center p-0">
				{crumbs.map((crumb, index) => {
					const last = index === crumbs.length - 1;
					return (
						<li
							key={`${index}:${crumb.label}`}
							className={cn(
								"flex min-w-0 items-center whitespace-nowrap before:mx-2 before:text-border-strong before:content-['/']",
								last && "overflow-hidden",
								index < crumbs.length - 2 && "to-560:hidden",
							)}
						>
							{crumb.href && !last ? (
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

/** The top bar: the GitHive mark, which leads home, where you are, the Inbox, your agents, light or dark, and who you are. */
export function TopBar({
	crumbs,
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
		<header className="sticky top-0 z-10 border-b border-border bg-card">
			<div className="mx-auto flex max-w-(--page-width) min-w-0 items-center gap-3.5 px-6 py-2.5 to-560:gap-2 to-560:px-4">
				<a
					className="inline-flex shrink-0 items-center gap-2 text-body font-bold text-foreground hover:no-underline"
					href="#/"
					aria-label="GitHive home"
				>
					<HiveMark />
					<span className="to-560:hidden">GitHive</span>
				</a>
				{crumbs.length > 0 ? <Breadcrumbs crumbs={crumbs} /> : null}
				{onSignIn ? (
					<Button variant="primary" className="ml-auto shrink-0" onClick={onSignIn}>
						Sign in
					</Button>
				) : (
					<InboxLink inboxCount={inboxCount} inboxCurrent={inboxCurrent} />
				)}
				{me?.kind === "user" ? <AgentsLink agentsCurrent={agentsCurrent} /> : null}
				{me?.kind === "access" ? (
					<a
						className={pill}
						href={href.admin()}
						aria-current={adminCurrent ? "page" : undefined}
						aria-label={adminRequests ? `Admin, ${adminRequests} requests waiting` : "Admin"}
					>
						<Icon name="settings" size={15} />
						<span className="to-560:hidden">Admin</span>
						{adminRequests ? <PillCount>{adminRequests}</PillCount> : null}
					</a>
				) : null}
				<ThemeMenu />
				{me?.kind === "user" ? (
					<UserMenu
						me={me}
						onSignOut={onSignOut ?? (() => undefined)}
						agentsCurrent={agentsCurrent}
						orgsCurrent={orgsCurrent}
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
