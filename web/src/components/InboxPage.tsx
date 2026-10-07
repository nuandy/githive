import type { InboxGroup } from "../lib/inbox";
import { Icon } from "./Icon";
import "./InboxPage.css";

/** Every change waiting on a person, across repos, with why. */
export function InboxPage({ groups, loaded, error }: { groups: InboxGroup[]; loaded: boolean; error?: string }) {
	const count = groups.reduce((sum, group) => sum + group.items.length, 0);
	return (
		<main className="page inbox" id="main">
			<div className="page__header">
				<h1>Inbox</h1>
				<p className="muted inbox__lead">Changes the agents can't move forward without you, in every repo.</p>
			</div>
			{!loaded ? (
				<p className="muted" role="status">
					Loading…
				</p>
			) : error && !groups.length ? (
				<div className="callout callout--bad" role="alert">
					<Icon name="x" className="tone-bad" />
					<div>
						<strong>Couldn't load the inbox</strong>
						<p>{error}</p>
					</div>
				</div>
			) : count === 0 ? (
				<div className="box empty">
					<Icon name="check-circle" size={32} className="tone-good" />
					<h2>Nothing waits on you</h2>
					<p>When a change needs a decision (reviewers disagree, checks keep failing, an agent is stuck), it shows up here.</p>
				</div>
			) : (
				groups.map((group) => (
					<section key={group.repo} className="box inbox__group" aria-labelledby={`inbox-${group.repo}`}>
						<div className="box__header">
							<h2 id={`inbox-${group.repo}`} className="inbox__repo">
								<Icon name="repo" className="muted" />
								<a href={group.repoHref}>{group.repo}</a>
							</h2>
							<span className="counter">{group.items.length}</span>
						</div>
						<ul className="inbox__items">
							{group.items.map((item) => (
								<li key={item.change} className="inbox__item">
									<span className="tone-needs inbox__icon">
										<Icon name="alert" />
									</span>
									<div className="inbox__main">
										<a href={item.href} className="inbox__title">
											{item.title}
										</a>
										<span className="inbox__id">{item.change}</span>
										<p className="inbox__reason">{item.reason}</p>
									</div>
								</li>
							))}
						</ul>
					</section>
				))
			)}
		</main>
	);
}
