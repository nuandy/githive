import { Icon } from "./Icon";
import "./TopBar.css";

export interface Crumb {
	label: string;
	href?: string;
}

/** The top bar: the GitHive mark, which leads home, and where you are. */
export function TopBar({ crumbs, inboxCount, inboxCurrent = false }: { crumbs: Crumb[]; /** Changes waiting on a person, across repos; undefined until known. */ inboxCount?: number; inboxCurrent?: boolean }) {
	return (
		<header className="topbar">
			<div className="topbar__inner">
				<a className="topbar__brand" href="#/" aria-label="GitHive home">
					{/* A beehive (a skep): stacked bands and an entrance, on honey. */}
					<svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
						<rect width="32" height="32" rx="7" fill="#f2a516" />
						<g fill="#fff" stroke="#f2a516" strokeWidth="1.2">
							<rect x="12" y="5.5" width="8" height="5" rx="2.5" />
							<rect x="9" y="10" width="14" height="5" rx="2.5" />
							<rect x="7" y="14.5" width="18" height="5" rx="2.5" />
							<rect x="6" y="19" width="20" height="5.5" rx="2.75" />
						</g>
						<rect x="4.5" y="24.2" width="23" height="2.6" rx="1.3" fill="#fff" />
						<path d="M13.6 24.4a2.4 2.4 0 0 1 4.8 0z" fill="#7a4a06" />
					</svg>
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
			</div>
		</header>
	);
}
