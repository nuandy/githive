import { useEffect, useRef } from "react";
import type { Me } from "../api";
import { href } from "../lib/routes";
import { HiveMark } from "./HiveMark";
import { Icon } from "./Icon";
import "./TopBar.css";

export interface Crumb {
	label: string;
	href?: string;
}

/** A signed-in person's menu: their face or initial and handle, their agents, and signing out. */
export function UserMenu({ me, onSignOut, agentsCurrent = false }: { me: Extract<Me, { kind: "user" }>; onSignOut: () => void; agentsCurrent?: boolean }) {
	const initial = (me.name || me.handle).trim().charAt(0).toUpperCase() || "?";
	const menu = useRef<HTMLDetailsElement>(null);
	const close = () => {
		if (menu.current) menu.current.open = false;
	};
	// A <details> stays open until it's toggled; a menu closes once it has done its job.
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (menu.current?.open && !menu.current.contains(event.target as Node)) close();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && menu.current?.open) {
				close();
				menu.current.querySelector("summary")?.focus();
			}
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		window.addEventListener("hashchange", close);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
			window.removeEventListener("hashchange", close);
		};
	}, []);
	return (
		<details className="usermenu" ref={menu}>
			<summary className="usermenu__summary" aria-label={`Signed in as ${me.handle}`}>
				{me.avatarUrl ? <img className="usermenu__avatar" src={me.avatarUrl} alt="" width={22} height={22} referrerPolicy="no-referrer" /> : <span className="usermenu__avatar usermenu__avatar--initial" aria-hidden="true">{initial}</span>}
				<span className="usermenu__handle">{me.handle}</span>
			</summary>
			<div className="usermenu__panel" role="menu">
				<div className="usermenu__who">
					<strong>{me.name || me.handle}</strong>
					<span className="muted">{me.email}</span>
				</div>
				<a role="menuitem" className="usermenu__item" href={href.agents()} aria-current={agentsCurrent ? "page" : undefined} onClick={close}>
					<Icon name="bot" size={15} /> Agents
				</a>
				<button
					type="button"
					role="menuitem"
					className="usermenu__item"
					onClick={() => {
						close();
						onSignOut();
					}}
				>
					<Icon name="arrow" size={15} /> Sign out
				</button>
			</div>
		</details>
	);
}

/** The top bar: the GitHive mark, which leads home, where you are, the Inbox, and who you are. */
export function TopBar({
	crumbs,
	inboxCount,
	inboxCurrent = false,
	me,
	onSignOut,
	agentsCurrent = false,
}: {
	crumbs: Crumb[];
	/** Changes waiting on a person, across repos; undefined until known. */
	inboxCount?: number;
	inboxCurrent?: boolean;
	/** Who is looking: a signed-in person gets a menu; an Access caller sees their label, quietly. */
	me?: Me;
	onSignOut?: () => void;
	agentsCurrent?: boolean;
}) {
	return (
		<header className="topbar">
			<div className="topbar__inner">
				<a className="topbar__brand" href="#/" aria-label="GitHive home">
					<HiveMark />
					<span>GitHive</span>
				</a>
				{crumbs.length > 0 ? (
					<nav className="topbar__crumbs" aria-label="Breadcrumb">
						<ol>
							{crumbs.map((crumb, index) => {
								const last = index === crumbs.length - 1;
								return (
									<li key={`${index}:${crumb.label}`}>
											{crumb.href && !last ? (
												<a href={crumb.href}>{crumb.label}</a>
											) : (
												<span aria-current={last ? "page" : undefined}>{crumb.label}</span>
											)}
									</li>
								);
							})}
						</ol>
					</nav>
				) : null}
				<a className="topbar__inbox" href="#/inbox" aria-current={inboxCurrent ? "page" : undefined} aria-label={inboxCount ? `Inbox, ${inboxCount} waiting on you` : "Inbox"}>
					<Icon name="alert" size={15} />
					<span className="topbar__inbox-label">Inbox</span>
					{inboxCount ? <span className="topbar__inbox-count">{inboxCount}</span> : null}
				</a>
				{me?.kind === "user" ? <UserMenu me={me} onSignOut={onSignOut ?? (() => undefined)} agentsCurrent={agentsCurrent} /> : null}
				{me?.kind === "access" ? (
					<span className="topbar__access" title="Signed in through Cloudflare Access">
						{me.label}
					</span>
				) : null}
			</div>
		</header>
	);
}
