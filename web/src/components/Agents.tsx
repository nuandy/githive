import type { RepoSnapshot } from "../api";
import { authorStats, reviewerStats, type AuthorStats, type ReviewerStats } from "../lib/people";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import "./Agents.css";

function Authors({ authors }: { authors: AuthorStats[] }) {
	return (
		<section className="box" aria-labelledby="agents-authors">
			<div className="box__header">
				<h2 id="agents-authors">Who opens changes</h2>
			</div>
			{authors.length ? (
				<div className="agents__scroll">
					<table className="agents__table">
						<thead>
							<tr>
								<th scope="col">Agent</th>
								<th scope="col">Claims in force</th>
								<th scope="col">Last active</th>
							</tr>
						</thead>
						<tbody>
							{authors.map((a) => (
								<tr key={a.name}>
									<th scope="row">
										<Icon name={a.name === "GitHive builder" ? "bot" : "user"} size={14} className="muted" /> {a.name}
									</th>
									<td>{a.open}</td>
									<td className="muted">{a.lastActive ? timeAgo(a.lastActive) : "–"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="box__row muted">No changes yet.</p>
			)}
		</section>
	);
}

function Reviewers({ reviewers }: { reviewers: ReviewerStats[] }) {
	return (
		<section className="box" aria-labelledby="agents-reviewers">
			<div className="box__header">
				<h2 id="agents-reviewers">Who reviews</h2>
			</div>
			{reviewers.length ? (
				<div className="agents__scroll">
					<table className="agents__table">
						<thead>
							<tr>
								<th scope="col">Reviewer</th>
								<th scope="col">Roles</th>
								<th scope="col">Approved</th>
								<th scope="col">Requested changes</th>
								<th scope="col">Last active</th>
							</tr>
						</thead>
						<tbody>
							{reviewers.map((r) => (
								<tr key={r.name}>
									<th scope="row">
										<Icon name={r.hosted ? "bot" : "shield"} size={14} className="muted" /> {r.name}
									</th>
									<td>{r.roles.join(", ")}</td>
									<td className={r.approvals ? "tone-good" : undefined}>{r.approvals}</td>
									<td className={r.rejections ? "tone-bad" : undefined}>{r.rejections}</td>
									<td className="muted">{r.lastActive ? timeAgo(r.lastActive) : "–"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="box__row muted">No reviews yet.</p>
			)}
		</section>
	);
}

/** A repo's agents, from the claims in force and the recent votes. */
export function AgentsTab({ snapshot }: { snapshot: RepoSnapshot }) {
	return (
		<div className="agents">
			<p className="muted agents__note">
				Repos keep no list of agents: these come from the claims in force and the latest votes.
			</p>
			<Authors authors={authorStats(snapshot)} />
			<Reviewers reviewers={reviewerStats(snapshot)} />
		</div>
	);
}
