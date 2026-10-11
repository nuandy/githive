import type { HiveEvent, RepoSnapshot } from "../api";
import { afterAgent, feedLine } from "../lib/hive";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { Icon, type IconName } from "./Icon";

/** How many events the feed shows; the server keeps more. */
const FEED_SHOWN = 30;

// What agents hear, marked apart from what they did: an interface change landed, a heads-up between two open
// changes, a merge that conflicted. A small icon, named for screen readers.
const MARKERS: Partial<Record<HiveEvent["kind"], { icon: IconName; label: string }>> = {
	interface: { icon: "merge", label: "Interface change" },
	heads_up: { icon: "eye", label: "Heads-up" },
	conflicted: { icon: "conflict", label: "Conflict" },
};

/** The hive's live feed: what each agent just did, newest first. */
export function HiveFeed(props: {
	repo: string;
	snapshot: RepoSnapshot;
	events?: HiveEvent[];
	error?: string;
	now: number;
}) {
	const { repo, snapshot, events, error, now } = props;
	const lines = (events ?? []).slice(0, FEED_SHOWN).map((event) => feedLine(event, snapshot));
	return (
		<section className="box hive-tab__feed" aria-labelledby="hive-feed">
			<div className="box__header">
				<h2 id="hive-feed">Right now</h2>
			</div>
			{error ? <p className="error">{error}</p> : null}
			{!lines.length && !error ? <p className="muted hive-tab__quiet">Quiet: nothing has happened lately.</p> : null}
			<ol className="hive-tab__rows">
				{lines.map((line, index) => {
					const marker = MARKERS[line.kind];
					return (
						<li key={`${line.at}:${index}`} className={`hive-tab__event hive-tab__event--${line.kind}`}>
							<span>
								{marker ? (
									<Icon name={marker.icon} size={13} className="hive-tab__marker" label={marker.label} />
								) : null}
								<strong>{line.agent}</strong>
								{afterAgent(line)}
								{line.action} {line.toChange ? `${line.toChange} ` : null}
								{line.change ? <a href={href.change(repo, line.change)}>{line.change}</a> : null}
								{line.commit ? <code>{line.commit}</code> : null}
								{line.note ? <span className="muted"> · {line.note}</span> : null}
							</span>
							<time className="muted hive-tab__when" dateTime={line.at}>
								{timeAgo(line.at, now)}
							</time>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
