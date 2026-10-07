import type { FreeChangeHistory } from "../api";
import { shortSha } from "../lib/model";
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
