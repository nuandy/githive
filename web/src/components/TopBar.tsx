import { Icon } from "./Icon";
import "./TopBar.css";

export interface Crumb {
	label: string;
	href?: string;
}

/** The top bar: the Blueprint mark, which leads home, and where you are. */
export function TopBar({ crumbs, inboxCount, inboxCurrent = false }: { crumbs: Crumb[]; /** Changes waiting on a person, across repos; undefined until known. */ inboxCount?: number; inboxCurrent?: boolean }) {
	return (
		<header className="topbar">
			<div className="topbar__inner">
				<a className="topbar__brand" href="#/" aria-label="Blueprint home">
					<svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
						<rect width="32" height="32" rx="7" fill="#2f6fed" />
						<path d="M9 10h14M9 16h9M9 22h12" stroke="white" strokeWidth="3" strokeLinecap="round" />
					</svg>
					<span>Blueprint</span>
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
			</div>
		</header>
	);
}
