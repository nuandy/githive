import type { RepoSnapshot } from "../api";
import { HostedAgents, type HostedAgentsApi } from "./HostedAgents";
import { authorStats, reviewerStats, type AuthorStats, type ReviewerStats } from "../lib/people";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import "./Agents.css";

/** GitHive's own agents, whose names start githive-, and its one-off builder. */
const isGitHiveAgent = (name: string) => name === "GitHive builder" || name.startsWith("githive-");

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
							{authors.map((author) => (
								<tr key={author.name}>
									<th scope="row">
										<Icon name={isGitHiveAgent(author.name) ? "bot" : "user"} size={14} className="muted" />{" "}
										{author.name}
									</th>
									<td>{author.open}</td>
									<td className="muted">{author.lastActive ? timeAgo(author.lastActive) : "–"}</td>
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
							{reviewers.map((reviewer) => (
								<tr key={reviewer.name}>
									<th scope="row">
										<Icon name={reviewer.hosted ? "bot" : "shield"} size={14} className="muted" /> {reviewer.name}
									</th>
									<td>{reviewer.roles.join(", ")}</td>
									<td className={reviewer.approvals ? "tone-good" : undefined}>{reviewer.approvals}</td>
									<td className={reviewer.rejections ? "tone-bad" : undefined}>{reviewer.rejections}</td>
									<td className="muted">{reviewer.lastActive ? timeAgo(reviewer.lastActive) : "–"}</td>
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

/** A repo's agents, from the claims in force and the recent votes, and GitHive's hosted agents on it. */
export function AgentsTab({
	repo,
	snapshot,
	hosted,
}: {
	repo: string;
	snapshot: RepoSnapshot;
	hosted?: HostedAgentsApi;
}) {
	return (
		<div className="agents">
			<p className="muted agents__note">
				Repos keep no list of agents: these come from the claims in force and the latest votes.
			</p>
			<Authors authors={authorStats(snapshot)} />
			<Reviewers reviewers={reviewerStats(snapshot)} />
			{hosted ? <HostedAgents repo={repo} api={hosted} /> : null}
		</div>
	);
}
