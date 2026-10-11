import type { HiveEvent, RepoSnapshot } from "../api";
import { afterAgent, feedLine } from "../lib/hive";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";

/** How many events the feed shows; the server keeps more. */
const FEED_SHOWN = 30;

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
				{lines.map((line, index) => (
					<li key={`${line.at}:${index}`} className={`hive-tab__event hive-tab__event--${line.kind}`}>
						<span>
							<strong>{line.agent}</strong>
							{afterAgent(line)}
							{line.action} {line.change ? <a href={href.change(repo, line.change)}>{line.change}</a> : null}
							{line.commit ? <code>{line.commit}</code> : null}
							{line.note ? <span className="muted"> · {line.note}</span> : null}
						</span>
						<time className="muted hive-tab__when" dateTime={line.at}>
							{timeAgo(line.at, now)}
						</time>
					</li>
				))}
			</ol>
		</section>
	);
}
