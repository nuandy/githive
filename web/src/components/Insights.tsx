import type { HistoryEntry, Task } from "../api";
import { computeInsights, formatDuration, formatTokens, percent } from "../lib/insights";
import "./Insights.css";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="stat">
			<p className="stat__label">{label}</p>
			<p className="stat__value">{value}</p>
			{hint ? <p className="stat__hint">{hint}</p> : null}
		</div>
	);
}

/** One row of a bar chart; `parts` stack (e.g. approvals then requested changes). */
function Bar({ label, parts, max, value }: { label: string; parts: { amount: number; tone?: "good" | "bad" | "warn"; name: string }[]; max: number; value: string }) {
	return (
		<li className="bar">
			<span className="bar__label" title={label}>
				{label}
			</span>
			<span className="bar__track" role="img" aria-label={`${label}: ${parts.map((p) => `${p.amount} ${p.name}`).join(", ")}`}>
				{parts.map((part) => (
					<span key={part.name} className={`bar__fill${part.tone ? ` bar__fill--${part.tone}` : ""}`} style={{ width: `${max ? (part.amount / max) * 100 : 0}%` }} />
				))}
			</span>
			<span className="bar__value">{value}</span>
		</li>
	);
}

/** How a repo's changes have gone: throughput, time to merge, review and checks outcomes, review cost. */
export function Insights({ task, history }: { task: Task; history?: HistoryEntry[] | null }) {
	const data = computeInsights(task, history);
	const total = data.counts.open + data.counts.merged + data.counts.abandoned;
	if (total === 0)
		return (
			<div className="box empty">
				<h2>No changes yet</h2>
				<p>Insights appear once agents open changes in this repo.</p>
			</div>
		);
	const roleMax = Math.max(1, ...data.byRole.map((r) => r.approvals + r.rejections));
	const bucketMax = Math.max(1, ...data.revisions.buckets.map((b) => b.count));
	const costMax = Math.max(1, ...data.cost.byRole.map((r) => r.tokens));
	const checksTotal = data.checks.passed + data.checks.failed;
	return (
		<div className="insights">
			<div className="stat-grid">
				<Stat label="Merged" value={String(data.counts.merged)} hint={`${data.counts.open} open · ${data.counts.abandoned} abandoned`} />
				<Stat
					label="Median time to merge"
					value={data.medianMergeMs !== undefined ? formatDuration(data.medianMergeMs) : "–"}
					hint={data.timedMerges ? `over ${data.timedMerges} merged ${data.timedMerges === 1 ? "change" : "changes"}` : "no merged change records when it opened"}
				/>
				<Stat label="Approved at first review" value={percent(data.firstReview.approved, data.firstReview.reviewed)} hint={`${data.firstReview.approved} of ${data.firstReview.reviewed} reviewed changes`} />
				<Stat label="Revisions per change" value={data.revisions.average.toFixed(1)} hint={`at most ${data.revisions.max}`} />
				<Stat
					label="Checks passed"
					value={percent(data.checks.passed, checksTotal)}
					hint={checksTotal ? `${data.checks.passed} passed · ${data.checks.failed} failed${data.checks.source === "records" ? " (latest run per change)" : ""}` : "no check runs yet"}
				/>
				<Stat
					label="Review cost"
					value={data.cost.reviews ? `${formatTokens(data.cost.total)} tokens` : "–"}
					hint={data.cost.changes ? `${formatTokens(data.cost.total / data.cost.changes)} per change · Blueprint's own reviewers` : "only Blueprint's own reviewers are counted"}
				/>
			</div>

			<div className="insights__panels">
				<section className="box" aria-labelledby="insights-roles">
					<div className="box__header">
						<h2 id="insights-roles">Verdicts by reviewer role</h2>
						<span className="muted insights__legend">
							<span className="insights__key insights__key--good" /> approved <span className="insights__key insights__key--bad" /> requested changes
						</span>
					</div>
					<div className="box__body">
						{data.byRole.length ? (
							<ul className="bars">
								{data.byRole.map((role) => (
									<Bar
										key={role.role}
										label={role.role}
										max={roleMax}
										parts={[
											{ amount: role.approvals, tone: "good", name: "approved" },
											{ amount: role.rejections, tone: "bad", name: "requested changes" },
										]}
										value={`${role.approvals} / ${role.rejections}`}
									/>
								))}
							</ul>
						) : (
							<p className="muted">No reviews yet.</p>
						)}
					</div>
				</section>

				<section className="box" aria-labelledby="insights-revisions">
					<div className="box__header">
						<h2 id="insights-revisions">Times sent back</h2>
					</div>
					<div className="box__body">
						<ul className="bars">
							{data.revisions.buckets.map((bucket) => (
								<Bar key={bucket.label} label={bucket.label} max={bucketMax} parts={[{ amount: bucket.count, name: "changes" }]} value={`${bucket.count} ${bucket.count === 1 ? "change" : "changes"}`} />
							))}
						</ul>
					</div>
				</section>

				<section className="box" aria-labelledby="insights-checks">
					<div className="box__header">
						<h2 id="insights-checks">Check runs</h2>
					</div>
					<div className="box__body">
						{checksTotal ? (
							<ul className="bars">
								<Bar label="Passed" max={checksTotal} parts={[{ amount: data.checks.passed, tone: "good", name: "passed" }]} value={String(data.checks.passed)} />
								<Bar label="Failed" max={checksTotal} parts={[{ amount: data.checks.failed, tone: "bad", name: "failed" }]} value={String(data.checks.failed)} />
							</ul>
						) : (
							<p className="muted">No check runs yet.</p>
						)}
					</div>
				</section>

				<section className="box" aria-labelledby="insights-cost">
					<div className="box__header">
						<h2 id="insights-cost">Review cost by role</h2>
					</div>
					<div className="box__body">
						{data.cost.byRole.length ? (
							<>
								<ul className="bars">
									{data.cost.byRole.map((role) => (
										<Bar
											key={role.role}
											label={role.role}
											max={costMax}
											parts={[{ amount: role.tokens, name: "tokens" }]}
											value={`${formatTokens(role.tokens)} · ${role.reviews} ${role.reviews === 1 ? "review" : "reviews"}`}
										/>
									))}
								</ul>
								<p className="muted insights__note">
									{formatTokens(data.cost.input)} in · {formatTokens(data.cost.output)} out{data.cost.cacheRead ? ` · ${formatTokens(data.cost.cacheRead)} read from cache` : ""}. Outside agents' and people's reviews cost nothing here.
								</p>
							</>
						) : (
							<p className="muted">No reviews by Blueprint's own reviewers recorded their cost yet.</p>
						)}
					</div>
				</section>
			</div>
		</div>
	);
}
