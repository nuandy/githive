import type { RepoLanding, RepoSnapshot } from "../api";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import "./Overview.css";

const SETTLED_COLOR: Record<RepoLanding["recent"][number]["how"], "green" | "red"> = { landed: "green", failed: "red" };

/** What goes before the item at `index` in a list of `length` read as a sentence: nothing, a comma, or "and". */
function listSeparator(index: number, length: number): string | null {
	if (!index) return null;
	return index === length - 1 ? " and " : ", ";
}

/**
 * What's landing on the branch, drawn as a track into it: the changes being
 * checked together nearest it, the approved ones waiting for the next batch.
 */
export function LandingTrack({
	repo,
	branch,
	snapshot,
	landing,
	error,
}: {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	landing?: RepoLanding;
	error?: string;
}) {
	const checking = landing?.checking?.changes ?? [];
	const inBatch = new Set(checking.map((checked) => checked.change));
	const waiting = snapshot.claims.filter((claim) => claim.approval.approved && !inBatch.has(claim.change)).length;
	// Each change's last outcome, newest first.
	const lastOutcomes = new Map((landing?.recent ?? []).map((outcome) => [outcome.change, outcome]));
	const recent = [...lastOutcomes.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
	return (
		<section className="track" aria-labelledby="track-title">
			<div className="overview__head">
				<h2 id="track-title">Landing</h2>
				<p className="muted">
					Approved changes land on {branch} together: checked once as a batch
					{snapshot.verify.length ? " by running " : ""}
					{snapshot.verify.map((command, index) => (
						<span key={command}>
							{listSeparator(index, snapshot.verify.length)}
							<code className="nowrap">{command}</code>
						</span>
					))}
					, then landed in one push.
				</p>
			</div>
			{error && !landing ? <p className="muted">What's landing couldn't be read: {error}</p> : null}
			<ol className="track__plan">
				<li className="track__end">
					<span className="track__buffer" aria-hidden="true" />
					<span className="track__name">{branch}</span>
					{landing?.checking ? <code className="track__detail">{landing.checking.base.slice(0, 7)}</code> : null}
				</li>
				{checking.map((checked) => (
					<li key={checked.change} className="track__station lamp--amber">
						<span className="lamp lamp--track" aria-hidden="true" />
						<a className="track__name" href={href.change(repo, checked.change)}>
							{checked.change}
						</a>
						<span className="track__detail">checking</span>
						<span className="track__detail muted">{checked.agent}</span>
					</li>
				))}
				{waiting ? <li className="track__waiting">{waiting} approved, landing with the next batch</li> : null}
			</ol>
			{landing && !checking.length ? (
				<p className="track__empty muted">
					Nothing being checked. Approved changes land with the next batch, once one of them merges.
				</p>
			) : null}
			{recent.length ? (
				<div className="track__left">
					<h3>Lately</h3>
					<ul>
						{recent.map((outcome) => (
							<li key={`${outcome.change}-${outcome.at}`} className={`lamp--${SETTLED_COLOR[outcome.how]}`}>
								<span className="lamp" aria-hidden="true" />
								<span>
									<a href={href.change(repo, outcome.change)}>{outcome.change}</a>{" "}
									{outcome.how === "landed" ? "landed" : "put out: its checks failed"}{" "}
									<span className="muted">{timeAgo(outcome.at)}</span>
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}
