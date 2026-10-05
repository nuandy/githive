import type { FreeChangeHistory } from "../api";
import { pushesNewestFirst } from "../lib/coordination";
import { shortSha, type Change } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { href, type RepoBase } from "../lib/routes";
import { Icon } from "./Icon";
import "./Commits.css";

function When({ at }: { at: string }) {
	return (
		<time dateTime={at} title={new Date(at).toLocaleString()}>
			{timeAgo(at)}
		</time>
	);
}

/** An elected change's pushes, newest first, with what the conflict check found on each. */
export function ChangeCommits({ change, repo, base }: { change: Change; repo: string; base: RepoBase }) {
	const pushes = pushesNewestFirst(change);
	if (!pushes.length)
		return (
			<div className="box empty">
				<Icon name="commit" size={28} className="muted" />
				<h2>No pushes yet</h2>
				<p>{change.head ? "This change's pushes weren't recorded (it predates the record)." : "Commits show up here as the agent pushes them."}</p>
			</div>
		);
	return (
		<section className="box commits" aria-labelledby="commits-title">
			<div className="box__header">
				<h2 id="commits-title">
					{pushes.length} {pushes.length === 1 ? "push" : "pushes"}
				</h2>
			</div>
			<ol className="commits__list">
				{pushes.map((push, index) => (
					<li key={`${push.head}:${index}`} className="commits__row">
						<Icon name="commit" className="muted commits__icon" />
						<div className="commits__main">
							<p className="commits__line">
								<a href={href.code(repo, "", base, push.head)}>
									<code>{shortSha(push.head)}</code>
								</a>
								<span className="muted">
									{" · "}
									{push.files} {push.files === 1 ? "file" : "files"} changed
								</span>
								{push.head === change.reviewHead ? <span className="pill pill--accent">in review</span> : null}
							</p>
							<p className="commits__badges">
								{push.conflicts ? (
									<span className="pill pill--warn">
										<Icon name="conflict" size={12} />
										{push.conflicts} {push.conflicts === 1 ? "conflict" : "conflicts"}
									</span>
								) : (
									<span className="pill pill--good">
										<Icon name="check" size={12} />
										no conflicts
									</span>
								)}
								{push.outOfLane ? (
									<span className="pill pill--warn">
										<Icon name="alert" size={12} />
										{push.outOfLane} outside its claim
									</span>
								) : null}
							</p>
						</div>
						<span className="muted commits__when">
							<When at={push.at} />
						</span>
					</li>
				))}
			</ol>
		</section>
	);
}

/** A coordinator-free change's own commits, newest first, with their messages. */
export function FreeCommits({ history, repo, base }: { history: FreeChangeHistory | undefined; repo: string; base: RepoBase }) {
	if (!history)
		return (
			<p className="muted" role="status">
				Loading commits…
			</p>
		);
	if (!history.commits.length)
		return (
			<div className="box empty">
				<Icon name="commit" size={28} className="muted" />
				<h2>No commits yet</h2>
				<p>Commits show up here as the agent pushes them to its branch.</p>
			</div>
		);
	return (
		<section className="box commits" aria-labelledby="commits-title">
			<div className="box__header">
				<h2 id="commits-title">
					{history.commits.length} {history.commits.length === 1 ? "commit" : "commits"}
				</h2>
			</div>
			<ol className="commits__list">
				{history.commits.map((commit) => {
					const [subject, ...rest] = commit.message.split("\n");
					return (
						<li key={commit.commit} className="commits__row">
							<Icon name="commit" className="muted commits__icon" />
							<div className="commits__main">
								<p className="commits__subject">{subject || "(no message)"}</p>
								{rest.join("\n").trim() ? (
									<details className="commits__more">
										<summary>More</summary>
										<pre>{rest.join("\n").trim()}</pre>
									</details>
								) : null}
								<p className="muted commits__meta">
									<strong>{commit.author || "someone"}</strong> committed <When at={commit.at} />
								</p>
							</div>
							<a className="commits__sha" href={href.code(repo, "", base, commit.commit)}>
								<code>{shortSha(commit.commit)}</code>
							</a>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
