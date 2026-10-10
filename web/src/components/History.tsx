import type { BranchHistory, LandedChange } from "../api";
import { usePoll } from "../hooks/usePoll";
import { shortSha } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { Icon } from "./Icon";
import "./Commits.css";
import "./History.css";

export interface HistoryApi {
	history?: (repo: string, branch: string) => Promise<BranchHistory>;
}

/** The History tab: the changes landed on the branch, loaded here and kept fresh. */
export function HistoryTab({ repo, branch, api }: { repo: string; branch: string; api: HistoryApi }) {
	const load = api.history;
	const poll = usePoll(load ? `history:${repo}:${branch}` : null, () => load!(repo, branch), 60_000);
	return <History repo={repo} history={poll.data} error={poll.data ? undefined : poll.error} />;
}

/** Each change landed on the branch, newest first: why it was made, who made it, and who approved it. */
export interface HistoryProps {
	repo: string;
	history: BranchHistory | undefined;
	error?: unknown;
}

export function History({ repo, history, error }: HistoryProps) {
	if (!history) {
		const status = error ? "The history couldn't be loaded." : "Loading history…";
		return (
			<p className="muted" role="status">
				{status}
			</p>
		);
	}
	if (!history.changes.length) {
		return (
			<div className="box empty">
				<Icon name="commit" size={28} className="muted" />
				<h2>Nothing has landed on {history.branch} yet</h2>
				<p>Each change that lands shows here, with why it was made and who reviewed it.</p>
			</div>
		);
	}
	const shown = history.changes.length;
	const more = history.total - shown;
	return (
		<section className="box commits history" aria-labelledby="history-title">
			<div className="box__header">
				<h2 id="history-title">
					{history.total} {history.total === 1 ? "change" : "changes"} landed on {history.branch}
				</h2>
			</div>
			<ol className="commits__list">
				{history.changes.map((landed) => (
					<HistoryRow key={landed.commit} repo={repo} landed={landed} />
				))}
			</ol>
			{more > 0 ? <p className="muted history__more">And {more} earlier, in the branch's own history.</p> : null}
		</section>
	);
}

function HistoryRow({ repo, landed }: { repo: string; landed: LandedChange }) {
	return (
		<li className="commits__row">
			<Icon name="merge" className="muted commits__icon" />
			<div className="commits__main">
				<p className="commits__subject">
					<a href={href.change(repo, landed.change)}>{landed.title}</a>
				</p>
				<p className="muted commits__meta">
					<strong>{landed.agent}</strong> landed <code>{landed.change}</code>
					{landed.at ? (
						<>
							{" "}
							<time dateTime={landed.at} title={new Date(landed.at).toLocaleString()}>
								{timeAgo(landed.at)}
							</time>
						</>
					) : null}
					{landed.files.length ? <span> · {fileCount(landed.files.length)}</span> : null}
				</p>
				{landed.reviews.length ? (
					<Reviews reviews={landed.reviews} />
				) : (
					<p className="muted history__none">Landed without review.</p>
				)}
			</div>
			<a className="commits__sha" href={href.code(repo, "", landed.commit)}>
				<code>{shortSha(landed.commit)}</code>
			</a>
		</li>
	);
}

function Reviews({ reviews }: { reviews: LandedChange["reviews"] }) {
	return (
		<ul className="history__reviews">
			{reviews.map((review) => (
				<li key={`${review.reviewer}:${review.role}:${review.verdict}`}>
					<Icon name={review.verdict === "approve" ? "check-circle" : "x-circle"} size={14} label={review.verdict} />
					<strong>{review.reviewer}</strong> <span className="muted">({review.role})</span> {review.evidence}
				</li>
			))}
		</ul>
	);
}

const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
