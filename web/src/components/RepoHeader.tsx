import type { ReactNode } from "react";
import type { LiveStatus } from "../lib/liveFeed";
import { Icon } from "./Icon";
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

/** A repo's name, badges and tabs, at the top of every page in it. */
export function RepoHeader({
	name,
	tabs,
	current,
	homeHref,
	live = "off",
	badges,
}: {
	name: string;
	tabs: TabItem[];
	current: string;
	homeHref: string;
	live?: LiveStatus;
	/** Badges after the name, e.g. how claims are kept. */
	badges?: ReactNode;
}) {
	return (
		<div className="repo-header">
			<div className="repo-header__inner">
				<div className="repo-header__top">
					<h1 className="repo-header__title">
						<Icon name="repo" className="muted" />
						<a href={homeHref}>{name}</a>
						{badges}
					</h1>
					<LiveDot status={live} />
				</div>
				<Tabs items={tabs} current={current} label={`${name} sections`} />
			</div>
		</div>
	);
}
