import { useState } from "react";
import type { FreeSnapshot, FreeVoteInput } from "../api";
import { shortSha } from "../lib/model";
import type { FreeClaim } from "../lib/freeStatus";
import { Icon } from "./Icon";
import "./ReviewForm.css";

export interface FreeVoteApi {
	freeVote(repo: string, change: string, vote: FreeVoteInput): Promise<unknown>;
}

/** The roles a person can vote as: a general review, and every role that can block a change here. */
export function freeVoteRoles(policy: FreeSnapshot["policy"]): string[] {
	return [...new Set(["review", ...(policy.vetoes ?? []), ...(policy.escalate ?? []).flatMap((e) => e.vetoes ?? [])])];
}

/**
 * A person's vote on a coordinator-free change, from its page: on its current
 * commit, stamped with their verified identity, counted like any reviewer's,
 * and answering an agent's question about it. The server's words show on refusal.
 */
export function FreeVoteForm({ repo, claim, policy, api }: { repo: string; claim: FreeClaim; policy: FreeSnapshot["policy"]; api: FreeVoteApi }) {
	const roles = freeVoteRoles(policy);
	const [role, setRole] = useState(roles[0]);
	const [verdict, setVerdict] = useState<"approve" | "reject">("approve");
	const [evidence, setEvidence] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [done, setDone] = useState<string>();
	if (!claim.head) return null;
	const head = claim.head;

	return (
		<form
			className="review-form"
			aria-labelledby="free-vote-title"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!evidence.trim() || busy) return;
				setBusy(true);
				setError(undefined);
				setDone(undefined);
				try {
					await api.freeVote(repo, claim.change, { role, verdict, evidence: evidence.trim() });
					setDone(`Your ${role} vote was recorded.`);
					setEvidence("");
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			<div className="review-form__header">
				<h2 id="free-vote-title">Review changes</h2>
				<span className="muted">
					on <code>{shortSha(head)}</code>
				</span>
			</div>
			<div className="review-form__body">
				<div className="review-form__row">
					<label htmlFor="free-vote-role">Vote as</label>
					<select id="free-vote-role" value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
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
						<input type="radio" name="free-verdict" value="approve" checked={verdict === "approve"} onChange={() => setVerdict("approve")} />
						<span>
							<strong>Approve</strong>
							<span className="muted">These changes can merge.</span>
						</span>
					</label>
					<label className={`review-form__choice${verdict === "reject" ? " is-selected" : ""}`}>
						<input type="radio" name="free-verdict" value="reject" checked={verdict === "reject"} onChange={() => setVerdict("reject")} />
						<span>
							<strong>Request changes</strong>
							<span className="muted">{policy.vetoes.includes(role) ? "Blocks the merge." : "The agent should address this before merging."}</span>
						</span>
					</label>
				</fieldset>
				<label htmlFor="free-vote-evidence">What you checked</label>
				<textarea id="free-vote-evidence" rows={3} required value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="What you looked at, and what you found" disabled={busy} />
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
					<button type="submit" className={verdict === "approve" ? "primary" : "danger"} disabled={busy || !evidence.trim()}>
						<Icon name={verdict === "approve" ? "check" : "x"} />
						{busy ? "Submitting…" : "Submit vote"}
					</button>
				</div>
			</div>
		</form>
	);
}
