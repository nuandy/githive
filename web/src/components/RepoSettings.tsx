import type { Task } from "../api";
import { newestChecks } from "../lib/conflicts";
import { changesOf, isActive } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import "./RepoSettings.css";

const CHECK_WORDS: Record<string, string> = { clean: "merge cleanly", disjoint: "touch different files", conflict: "conflict" };

/** How a repo is run: what must pass before a change merges, and how long claims last. Read-only. */
export function RepoSettings({ task }: { task: Task }) {
	const { review, verify } = task;
	const active = new Set(changesOf(task).filter(isActive).map((change) => change.id));
	const pairs = newestChecks(task).filter((check) => check.pair.every((id) => id === "base" || active.has(id)));
	const name = (id: string) => (id === "base" ? (task.branch ?? "main") : id);
	return (
		<div className="repo-settings">
			<section className="box" aria-labelledby="settings-checks">
				<div className="box__header">
					<h2 id="settings-checks">Merge checks</h2>
				</div>
				<div className="box__body">
					{verify.length ? (
						<>
							<p>Before a change merges, these commands must pass on the change combined with {task.branch ?? "main"}:</p>
							<ul className="repo-settings__commands">
								{verify.map((command) => (
									<li key={command}>
										<code>{command}</code>
									</li>
								))}
							</ul>
						</>
					) : (
						<p>No checks: a change merges as soon as it is approved.</p>
					)}
				</div>
			</section>

			<section className="box" aria-labelledby="settings-review">
				<div className="box__header">
					<h2 id="settings-review">Review policy</h2>
				</div>
				<div className="box__body">
					<dl className="repo-settings__list">
						<dt>Required approvals</dt>
						<dd>
							{review.required ? `${review.required} ${review.required === 1 ? "approval" : "approvals"} required` : "None: changes merge once the checks pass"}
						</dd>
						<dt>Reviewers</dt>
						<dd>{review.reviewers.length ? review.reviewers.map((role) => <span key={role} className="pill pill--outline">{role}</span>) : <span className="muted">None</span>}</dd>
						<dt>Can block a change</dt>
						<dd>
							{review.vetoes.length ? (
								<>
									{review.vetoes.map((role) => (
										<span key={role} className="pill pill--outline">
											{role}
										</span>
									))}
									<span className="muted"> A rejection from these blocks the change whatever the count.</span>
								</>
							) : (
								<span className="muted">No reviewer can block on their own.</span>
							)}
						</dd>
						<dt>Reviewed by outside agents</dt>
						<dd>
							{review.external?.length ? (
								<>
									{review.external.map((role) => (
										<span key={role} className="pill pill--outline">
											{role}
										</span>
									))}
									<span className="muted"> Outside agents take these from review_queue; Blueprint reviews the rest. A change waits {review.externalWaitMinutes ?? 60} minutes for them, then asks you.</span>
								</>
							) : (
								<span className="muted">None: Blueprint's own reviewers review every role.</span>
							)}
						</dd>
						{review.escalate?.length ? (
							<>
								<dt>Stricter review</dt>
								<dd>
									{review.escalate.map((e, i) => (
										<p key={i} className="repo-settings__escalation">
											Changes touching {e.paths.map((p, j) => <span key={p}>{j ? ", " : ""}<code>{p}</code></span>)} also need {[...new Set([...(e.reviewers ?? []), ...(e.vetoes ?? [])])].join(", ") || "more review"}
											{e.required ? `, ${e.required} approvals in all` : ""}
											{e.vetoes?.length ? ` (${e.vetoes.join(", ")} can block)` : ""}.
										</p>
									))}
								</dd>
							</>
						) : null}
					</dl>
				</div>
			</section>

			<section className="box" aria-labelledby="settings-claims">
				<div className="box__header">
					<h2 id="settings-claims">Claims</h2>
				</div>
				<div className="box__body">
					<dl className="repo-settings__list">
						<dt>Claim expiry</dt>
						<dd>
							{task.leaseMinutes
								? `A change's claim expires after ${task.leaseMinutes} ${task.leaseMinutes === 1 ? "minute" : "minutes"} without activity, freeing its paths.`
								: "Claims don't expire on their own."}
						</dd>
						{task.limits ? (
							<>
								<dt>Agents at once</dt>
								<dd>
									Up to {task.limits.builders} Blueprint {task.limits.builders === 1 ? "builder" : "builders"} and {task.limits.reviewers}{" "}
									{task.limits.reviewers === 1 ? "reviewer" : "reviewers"} run at a time; more wait their turn.
								</dd>
							</>
						) : null}
					</dl>
					<details className="repo-settings__details">
						<summary>Conflict checks between open changes ({pairs.length})</summary>
						<p className="muted">Each push is test-merged with {task.branch ?? "main"} and with every other open change, so conflicts show up before anything merges.</p>
						{pairs.length ? (
							<ul>
								{pairs.map((check) => (
									<li key={check.pair.join(":")}>
										<code>{name(check.pair[0])}</code> and <code>{name(check.pair[1])}</code>{" "}
										<span className={check.status === "conflict" ? "tone-bad" : "muted"}>{CHECK_WORDS[check.status] ?? check.status}</span>
										{check.status === "conflict" && check.files.length ? <span className="muted"> in {check.files.join(", ")}</span> : null}
										{check.checkedAt ? <span className="muted"> · {timeAgo(check.checkedAt)}</span> : null}
									</li>
								))}
							</ul>
						) : (
							<p className="muted">Nothing checked yet.</p>
						)}
					</details>
				</div>
			</section>
		</div>
	);
}
