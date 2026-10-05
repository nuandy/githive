import type { FreeSnapshot, Task } from "../api";
import { identityName } from "../lib/agent";
import { authorStats, freeAuthorStats, freeReviewerStats, registeredAgents, reviewerStats, type AuthorStats, type ReviewerStats } from "../lib/people";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import "./Agents.css";

function Authors({ authors, free }: { authors: AuthorStats[]; free?: boolean }) {
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
								<th scope="col">{free ? "Claims in force" : "Opened"}</th>
								{free ? null : (
									<>
										<th scope="col">Open</th>
										<th scope="col">Merged</th>
										<th scope="col">Abandoned</th>
									</>
								)}
								<th scope="col">Last active</th>
							</tr>
						</thead>
						<tbody>
							{authors.map((a) => (
								<tr key={a.name}>
									<th scope="row">
										<Icon name={a.name === "Blueprint builder" ? "bot" : "user"} size={14} className="muted" /> {a.name}
									</th>
									<td>{free ? a.open : a.opened}</td>
									{free ? null : (
										<>
											<td>{a.open}</td>
											<td className={a.merged ? "tone-good" : undefined}>{a.merged}</td>
											<td>{a.abandoned}</td>
										</>
									)}
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

/** An elected repo's agents: those registered, who opens changes, who reviews them. */
export function ElectedAgents({ task }: { task: Task }) {
	const registered = registeredAgents(task);
	return (
		<div className="agents">
			<section className="box" aria-labelledby="agents-registered">
				<div className="box__header">
					<h2 id="agents-registered">Registered outside agents</h2>
					<span className="counter">{registered.length}</span>
				</div>
				{registered.length ? (
					<ul className="agents__registered">
						{registered.map((agent) => (
							<li key={agent.name}>
								<Icon name="user" size={14} className="muted" />
								<strong>{agent.name}</strong>
								<span className="muted">
									since {timeAgo(agent.since)}
									{agent.by ? ` · by ${identityName(agent.by)}` : ""}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="box__row muted">
						No outside agent has registered a name yet. Agents register with the MCP <code>register_agent</code> tool, so their changes and reviews carry a name you can trust.
					</p>
				)}
			</section>
			<Authors authors={authorStats(task)} />
			<Reviewers reviewers={reviewerStats(task)} />
		</div>
	);
}

/** A coordinator-free repo's agents, from the claims in force and the recent votes. */
export function FreeAgents({ snapshot }: { snapshot: FreeSnapshot }) {
	return (
		<div className="agents">
			<p className="muted agents__note">Coordinator-free repos keep no list of agents: these come from the claims in force and the latest votes.</p>
			<Authors authors={freeAuthorStats(snapshot)} free />
			<Reviewers reviewers={freeReviewerStats(snapshot)} />
		</div>
	);
}
