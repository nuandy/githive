import type { ReactNode } from "react";
import type { Leader, Task } from "../api";
import { leaderChange } from "../lib/coordination";
import type { LiveStatus } from "../lib/liveFeed";
import type { RepoMode } from "../lib/repos";
import { href, type RepoBase } from "../lib/routes";
import { Icon } from "./Icon";
import { ModeBadge } from "./StatusPill";
import { Tabs, type TabItem } from "./Tabs";
import "./RepoHeader.css";

const LIVE_WORDS: Record<Exclude<LiveStatus, "off">, { label: string; title: string }> = {
	live: { label: "Live", title: "Connected: this page updates as soon as anything changes." },
	connecting: { label: "Connecting", title: "Connecting to live updates; until then the page refreshes every few seconds." },
	reconnecting: { label: "Reconnecting", title: "Live updates dropped; reconnecting. Until then the page refreshes every few seconds." },
};

export function LiveDot({ status }: { status: LiveStatus }) {
	if (status === "off") return null;
	const words = LIVE_WORDS[status];
	return (
		<span className={`live-dot live-dot--${status}`} title={words.title} role="status" aria-live="polite">
			<span className="live-dot__dot" aria-hidden="true" />
			{words.label}
		</span>
	);
}

const COORDINATOR_HELP =
	"There is no central server here: each open change has its own peer, and one of them is elected to coordinate the repo, deciding claims, reviews and merges for all. If it goes away, another peer campaigns and takes over with a new term.";

/** Who coordinates an elected repo now, from its leader record. */
export function CoordinatorLine({ leader, task, repo, base }: { leader?: Leader; task: Pick<Task, "id" | "slices">; repo: string; base: RepoBase }) {
	if (!leader) return null;
	const current = leaderChange(leader, task);
	return (
		<p className="repo-header__coordinator" title={COORDINATOR_HELP}>
			<Icon name="shield" size={14} className="muted" />
			{current ? (
				<span>
					Coordinated by <a href={href.change(repo, current.id, "conversation", base)}>{current.change?.title || current.id}</a>
					<span className="muted"> · term {leader.term}</span>
				</span>
			) : (
				<span className="muted">No coordinator elected now — the next change to arrive elects one</span>
			)}
			<span className="sr-only">. {COORDINATOR_HELP}</span>
		</p>
	);
}

/** A repo's name, mode and tabs, at the top of every page in it. */
export function RepoHeader({
	name,
	mode,
	tabs,
	current,
	homeHref,
	live = "off",
	coordinator,
}: {
	name: string;
	mode: RepoMode;
	tabs: TabItem[];
	current: string;
	homeHref: string;
	live?: LiveStatus;
	/** A line under the name, e.g. who coordinates. */
	coordinator?: ReactNode;
}) {
	return (
		<div className="repo-header">
			<div className="repo-header__inner">
				<div className="repo-header__top">
					<h1 className="repo-header__title">
						<Icon name="repo" className="muted" />
						<a href={homeHref}>{name}</a>
						<ModeBadge mode={mode} />
					</h1>
					<LiveDot status={live} />
				</div>
				{coordinator}
				<Tabs items={tabs} current={current} label={`${name} sections`} />
			</div>
		</div>
	);
}
