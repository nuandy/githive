import { type FormEvent, useState } from "react";
import type { RepoSnapshot, VoteInput } from "../api";
import { shortSha } from "../lib/model";
import type { Claim } from "../lib/claimStatus";
import { Icon } from "./Icon";
import "./ReviewForm.css";

export interface VoteApi {
	vote(repo: string, change: string, vote: VoteInput): Promise<unknown>;
}

/** The roles a person can vote as: a general review, and every role that can block a change here. */
export function voteRoles(policy: RepoSnapshot["policy"]): string[] {
	const pathVetoes = (policy.escalate ?? []).flatMap((rule) => rule.vetoes ?? []);
	return [...new Set(["review", ...(policy.vetoes ?? []), ...pathVetoes])];
}

/**
 * A person's vote on a change's current commit, from its page. It is stamped with their verified identity,
 * counts like any reviewer's, and answers an agent's question about the change. A refusal shows the server's words.
 */
export function VoteForm({
	repo,
	claim,
	policy,
	api,
}: {
	repo: string;
	claim: Claim;
	policy: RepoSnapshot["policy"];
	api: VoteApi;
}) {
	const roles = voteRoles(policy);
	const [role, setRole] = useState(roles[0]);
	const [verdict, setVerdict] = useState<"approve" | "reject">("approve");
	const [evidence, setEvidence] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [done, setDone] = useState<string>();
	if (!claim.head) return null;
	const head = claim.head;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!evidence.trim() || busy) return;
		setBusy(true);
		setError(undefined);
		setDone(undefined);
		try {
			await api.vote(repo, claim.change, { role, verdict, evidence: evidence.trim() });
			setDone(`Your ${role} vote was recorded.`);
			setEvidence("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="review-form" aria-labelledby="vote-title" onSubmit={submit}>
			<div className="review-form__header">
				<h2 id="vote-title">Review changes</h2>
				<span className="muted">
					on <code>{shortSha(head)}</code>
				</span>
			</div>
			<div className="review-form__body">
				<div className="review-form__row">
					<label htmlFor="vote-role">Vote as</label>
					<select id="vote-role" value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
						{roles.map((option) => (
							<option key={option} value={option}>
								{option} reviewer
							</option>
						))}
					</select>
				</div>
				<fieldset className="review-form__verdict" disabled={busy}>
					<legend className="sr-only">Verdict</legend>
					<label className={`review-form__choice${verdict === "approve" ? " is-selected" : ""}`}>
						<input
							type="radio"
							name="verdict"
							value="approve"
							checked={verdict === "approve"}
							onChange={() => setVerdict("approve")}
						/>
						<span>
							<strong>Approve</strong>
							<span className="muted">These changes can merge.</span>
						</span>
					</label>
					<label className={`review-form__choice${verdict === "reject" ? " is-selected" : ""}`}>
						<input
							type="radio"
							name="verdict"
							value="reject"
							checked={verdict === "reject"}
							onChange={() => setVerdict("reject")}
						/>
						<span>
							<strong>Request changes</strong>
							<span className="muted">
								{policy.vetoes.includes(role) ? "Blocks the merge." : "The agent should address this before merging."}
							</span>
						</span>
					</label>
				</fieldset>
				<label htmlFor="vote-evidence">What you checked</label>
				<textarea
					id="vote-evidence"
					rows={3}
					required
					value={evidence}
					onChange={(event) => setEvidence(event.target.value)}
					placeholder="What you looked at, and what you found"
					disabled={busy}
				/>
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
					<button
						type="submit"
						className={verdict === "approve" ? "primary" : "danger"}
						disabled={busy || !evidence.trim()}
					>
						<Icon name={verdict === "approve" ? "check" : "x"} />
						{busy ? "Submitting…" : "Submit vote"}
					</button>
				</div>
			</div>
		</form>
	);
}
