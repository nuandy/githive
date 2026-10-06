import { useState } from "react";
import type { ReviewInput, Task } from "../api";
import { changePolicy } from "../lib/changeStatus";
import { canReview, reviewRoles } from "../lib/coordination";
import { shortSha, type Change } from "../lib/model";
import { Icon } from "./Icon";
import "./ReviewForm.css";

export interface ReviewFormApi {
	submitReview(taskId: string, changeId: string, review: ReviewInput): Promise<unknown>;
}

/**
 * "Review changes", as on a pull request: a signed-in person reviews one role
 * of the commit under review. The server refuses the change's own author, a
 * second role on the same commit, or a commit that moved on; its words show.
 */
export function ReviewForm({ task, change, api, onChanged }: { task: Task; change: Change; api: ReviewFormApi; onChanged(): void }) {
	const { roles, suggested } = reviewRoles(change, task);
	const [role, setRole] = useState<string | undefined>(undefined);
	const [verdict, setVerdict] = useState<"approve" | "reject">("approve");
	const [summary, setSummary] = useState("");
	const [evidence, setEvidence] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [done, setDone] = useState<string>();
	if (!canReview(change, changePolicy(change, task)) || !roles.length) return null;
	const chosen = role && roles.includes(role) ? role : suggested!;
	const head = change.reviewHead!;

	return (
		<form
			className="review-form"
			aria-labelledby="review-form-title"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!summary.trim() || busy) return;
				setBusy(true);
				setError(undefined);
				setDone(undefined);
				try {
					await api.submitReview(task.id, change.id, { reviewer: chosen, head, verdict, summary: summary.trim(), ...(evidence.trim() ? { evidence: evidence.trim() } : {}) });
					setDone(`Your ${chosen} review was recorded.`);
					setSummary("");
					setEvidence("");
					onChanged();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			<div className="review-form__header">
				<h2 id="review-form-title">Review changes</h2>
				<span className="muted">
					on <code>{shortSha(head)}</code>
				</span>
			</div>
			<div className="review-form__body">
				<div className="review-form__row">
					<label htmlFor="review-role">Review as</label>
					<select id="review-role" value={chosen} onChange={(event) => setRole(event.target.value)} disabled={busy}>
						{roles.map((r) => (
							<option key={r} value={r}>
								{r} reviewer
							</option>
						))}
					</select>
				</div>
				<fieldset className="review-form__verdict" disabled={busy}>
					<legend className="sr-only">Verdict</legend>
					<label className={`review-form__choice${verdict === "approve" ? " is-selected" : ""}`}>
						<input type="radio" name="verdict" value="approve" checked={verdict === "approve"} onChange={() => setVerdict("approve")} />
						<span>
							<strong>Approve</strong>
							<span className="muted">These changes can merge.</span>
						</span>
					</label>
					<label className={`review-form__choice${verdict === "reject" ? " is-selected" : ""}`}>
						<input type="radio" name="verdict" value="reject" checked={verdict === "reject"} onChange={() => setVerdict("reject")} />
						<span>
							<strong>Request changes</strong>
							<span className="muted">The agent must address this before merging.</span>
						</span>
					</label>
				</fieldset>
				<label htmlFor="review-summary">Summary</label>
				<textarea id="review-summary" rows={3} required value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What you checked and what you found" disabled={busy} />
				<label htmlFor="review-evidence">
					Evidence <span className="muted">(optional)</span>
				</label>
				<textarea id="review-evidence" rows={2} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="Test output, a failing case, a benchmark" disabled={busy} />
				{error ? (
					<p className="tone-bad review-form__feedback" role="alert">
						{error}
					</p>
				) : null}
				{done ? (
					<p className="tone-good review-form__feedback" role="status">
						{done}
					</p>
				) : null}
				<div className="review-form__actions">
					<button type="submit" className={verdict === "approve" ? "primary" : "danger"} disabled={busy || !summary.trim()}>
						<Icon name={verdict === "approve" ? "check" : "x"} />
						{busy ? "Submitting…" : "Submit review"}
					</button>
				</div>
			</div>
		</form>
	);
}
