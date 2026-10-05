import { useState, type ReactNode } from "react";
import type { Task, UnifiedCodeDiff } from "../api";
import { isHosted } from "../lib/agent";
import { humanizeText } from "../lib/humanize";
import { checksSummary, currentGate, deriveChangeStatus, reviewSummary } from "../lib/changeStatus";
import { describeConflict, type Conflict } from "../lib/conflicts";
import { isActive, type Change } from "../lib/model";
import { href, type RepoBase } from "../lib/routes";
import { Icon, type IconName } from "./Icon";
import "./ChangeActions.css";

/** What a person can do to a change; the dashboard's api object satisfies it. */
export interface ChangeActionsApi {
	waive(taskId: string, changeId: string, reason: string): Promise<unknown>;
	messageBuilder(taskId: string, changeId: string, message: string): Promise<unknown>;
	retryChecks(taskId: string, changeId: string): Promise<unknown>;
	abandon(taskId: string, changeId: string, reason: string): Promise<unknown>;
	sliceDiff(taskId: string, changeId: string): Promise<UnifiedCodeDiff>;
}

/** Which actions apply to a change right now. */
export function availableActions(change: Change, verify: string[]) {
	const active = isActive(change);
	const building = change.status === "building";
	return {
		waive: building && change.attention != null && !!change.reviewHead,
		message: building && isHosted(change),
		retryChecks: building && currentGate(change)?.status === "failed" && verify.length > 0,
		abandon: active && building,
	};
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** One action's progress: running, failed with a reason, or done with a note. */
function useAction() {
	const [state, setState] = useState<{ busy: boolean; error?: string; done?: string }>({ busy: false });
	const run = async (work: () => Promise<unknown>, done: string | ((result: unknown) => string)) => {
		setState({ busy: true });
		try {
			const result = await work();
			setState({ busy: false, done: typeof done === "function" ? done(result) : done });
			return true;
		} catch (error) {
			setState({ busy: false, error: message(error) });
			return false;
		}
	};
	return { ...state, run };
}

function Feedback({ error, done }: { error?: string; done?: string }) {
	if (error)
		return (
			<p className="change-actions__feedback tone-bad" role="alert">
				{error}
			</p>
		);
	if (done)
		return (
			<p className="change-actions__feedback tone-good" role="status">
				{done}
			</p>
		);
	return null;
}

function StatusRow({ icon, tone, title, children }: { icon: IconName; tone: string; title: string; children?: ReactNode }) {
	return (
		<div className="merge-box__row">
			<span className={`merge-box__icon merge-box__icon--${tone}`} aria-hidden="true">
				<Icon name={icon} size={16} />
			</span>
			<div className="merge-box__text">
				<strong>{title}</strong>
				{children ? <div className="muted">{children}</div> : null}
			</div>
		</div>
	);
}

export interface ChangeActionsProps {
	task: Task;
	change: Change;
	conflicts: Conflict[];
	repo: string;
	base: RepoBase;
	/** The diff of the commit under review: a person approves only what they could see. */
	diffStatus: "loading" | "loaded" | "failed";
	api: ChangeActionsApi;
	onChanged(): void;
}

/** The box at the bottom of a change's conversation: where it stands, and what you can do. */
export function ChangeActions({ task, change, conflicts, repo, base, diffStatus, api, onChanged }: ChangeActionsProps) {
	const status = deriveChangeStatus(change, task.review, task.branch);
	const review = reviewSummary(change, task.review);
	const checks = checksSummary(change, task.verify, task.branch);
	const can = availableActions(change, task.verify);
	const [reason, setReason] = useState("");
	const [note, setNote] = useState("");
	const [abandonReason, setAbandonReason] = useState("");
	const waive = useAction();
	const send = useAction();
	const rerun = useAction();
	const abandon = useAction();
	const diffLoaded = diffStatus === "loaded";

	if (change.status === "integrated")
		return (
			<section className="merge-box merge-box--merged" aria-label="Merge status">
				<StatusRow icon="merge" tone="good" title={`Merged into ${task.branch ?? "main"}`}>
					This change is part of {task.branch ?? "main"}.
				</StatusRow>
			</section>
		);
	if (change.status === "abandoned")
		return (
			<section className="merge-box" aria-label="Merge status">
				<StatusRow icon="ban" tone="neutral" title="Abandoned">
					This change was given up and its claim is free again.
				</StatusRow>
			</section>
		);

	const waiting = review.reviewers.filter((r) => !r.verdict).map((r) => r.role);
	const rejecting = review.reviewers.filter((r) => r.verdict === "reject").map((r) => r.role);
	const reviewText =
		review.state === "none"
			? "Reviewers start once the agent submits its work."
			: review.state === "approved"
				? `${review.approvals} of ${review.required} required approvals.`
				: review.state === "waived"
					? "A person approved this commit without full review."
					: review.state === "vetoed"
						? `${rejecting.join(", ")} blocked this change.`
						: review.state === "changes-requested"
							? `${rejecting.join(", ")} requested changes.${waiting.length ? ` Waiting for ${waiting.join(", ")}.` : ""}`
							: review.approvals >= review.required && review.awaiting.length
								? `${review.approvals} of ${review.required} required approvals, but ${review.awaiting.join(", ")} can block it and must approve too.`
								: `${review.approvals} of ${review.required} required approvals.${waiting.length ? ` Waiting for ${waiting.join(", ")}.` : ""}`;

	return (
		<section className="merge-box" aria-label="Merge status and actions">
			<StatusRow
				icon={review.state === "approved" || review.state === "waived" ? "check" : review.state === "none" ? "dot" : review.tone === "bad" ? "x" : "eye"}
				tone={review.state === "none" ? "neutral" : review.tone}
				title={review.state === "approved" ? "Approved" : review.state === "waived" ? "Review waived" : review.state === "none" ? "Not submitted for review yet" : review.state === "pending" ? (review.awaiting.length && review.approvals >= review.required ? review.label : "Review in progress") : review.label}
			>
				{reviewText}
			</StatusRow>
			<StatusRow
				icon={checks.state === "passed" ? "check" : checks.state === "failed" ? "x" : checks.state === "running" ? "loader" : checks.state === "none" || checks.state === "not-run" ? "dot" : "clock"}
				tone={checks.tone}
				title={checks.state === "not-run" ? "Checks run after approval" : checks.label}
			>
				{checks.state === "none" ? "This repo has no merge checks." : null}
				{checks.state !== "none" && checks.state !== "not-run" ? <a href={href.change(repo, change.id, "checks", base)}>Details</a> : null}
			</StatusRow>
			<StatusRow icon={conflicts.length ? "conflict" : "check"} tone={conflicts.length ? "warn" : "good"} title={conflicts.length ? "This change has conflicts" : "No conflicts found"}>
				{conflicts.length ? conflicts.map((conflict) => <div key={conflict.with}>{describeConflict(conflict)}</div>) : `It merges cleanly with ${task.branch ?? "main"} and the other open changes.`}
			</StatusRow>

			{status.kind === "needs-you" ? (
				<div className="merge-box__section merge-box__section--needs">
					<div className="callout callout--needs">
						<Icon name="alert" className="tone-needs" />
						<div>
							<strong>This change needs you</strong>
							<p>{change.attention ? humanizeText(change.attention, [change.id], task.branch) : "The agents can't go on without a person."}</p>
							{change.lastFeedback ? (
								<details className="merge-box__feedback">
									<summary>Latest feedback to the agent</summary>
									<pre tabIndex={0}>{humanizeText(change.lastFeedback, [change.id], task.branch)}</pre>
								</details>
							) : null}
						</div>
					</div>
					{can.waive ? (
						<form
							className="change-actions__form"
							onSubmit={async (event) => {
								event.preventDefault();
								if (!diffLoaded || !reason.trim()) return;
								if (await waive.run(() => api.waive(task.id, change.id, reason.trim()), "Approved. The checks run next.")) {
									setReason("");
									onChanged();
								}
							}}
						>
							<label htmlFor="waive-reason">Approve and merge anyway (waive review)</label>
							<p className="muted">
								Lets commit <code>{change.reviewHead?.slice(0, 7)}</code> through without the required approvals. The merge checks still run. Look at the{" "}
								<a href={href.change(repo, change.id, "files", base)}>files changed</a> first.
							</p>
							<textarea id="waive-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this can merge without full review" disabled={waive.busy} />
							<div className="change-actions__buttons">
								{diffStatus === "loading" ? <span className="muted">Loading the changes under review…</span> : null}
								{diffStatus === "failed" ? <span className="tone-bad">The changes under review couldn't be loaded, so they can't be approved here.</span> : null}
								<button type="submit" className="primary" disabled={waive.busy || !diffLoaded || !reason.trim()}>
									<Icon name="check" />
									{waive.busy ? "Approving…" : "Approve and merge anyway"}
								</button>
							</div>
							<Feedback error={waive.error} done={waive.done} />
						</form>
					) : null}
				</div>
			) : null}

			{can.retryChecks ? (
				<div className="merge-box__section">
					<div className="change-actions__inline">
						<p>
							<strong>Checks failed.</strong> <span className="muted">Re-run them if the failure wasn't the change's fault, for example after fixing {task.branch ?? "main"}.</span>
						</p>
						<button
							type="button"
							disabled={rerun.busy}
							onClick={async () => {
								if (await rerun.run(() => api.retryChecks(task.id, change.id), "Checks queued.")) onChanged();
							}}
						>
							<Icon name="rerun" />
							{rerun.busy ? "Starting…" : "Re-run checks"}
						</button>
					</div>
					<Feedback error={rerun.error} done={rerun.done} />
				</div>
			) : null}

			{can.message ? (
				<form
					className="merge-box__section change-actions__form"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!note.trim()) return;
						const ok = await send.run(
							() => api.messageBuilder(task.id, change.id, note.trim()),
							(result) => ((result as { delivered?: string } | null)?.delivered === "resumed" ? "Sent. The builder resumed to act on it." : "Sent. The builder reads it on its next turn."),
						);
						if (ok) {
							setNote("");
							onChanged();
						}
					}}
				>
					<label htmlFor="builder-message">Message the builder</label>
					<textarea id="builder-message" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Guidance, a correction, or an answer to its question" disabled={send.busy} />
					<div className="change-actions__buttons">
						<button type="submit" className="accent" disabled={send.busy || !note.trim()}>
							<Icon name="send" />
							{send.busy ? "Sending…" : "Send"}
						</button>
					</div>
					<Feedback error={send.error} done={send.done} />
				</form>
			) : null}

			{can.abandon ? (
				<details className="merge-box__section change-actions__danger">
					<summary>Abandon this change…</summary>
					<form
						className="change-actions__form"
						onSubmit={async (event) => {
							event.preventDefault();
							if (!abandonReason.trim()) return;
							if (await abandon.run(() => api.abandon(task.id, change.id, abandonReason.trim()), "Abandoned. Its claim is free again.")) {
								setAbandonReason("");
								onChanged();
							}
						}}
					>
						<p className="muted">Stops its agents and frees its claim on {change.owns.join(", ") || "its paths"}. This can't be undone.</p>
						<label htmlFor="abandon-reason">Reason</label>
						<textarea id="abandon-reason" rows={2} value={abandonReason} onChange={(event) => setAbandonReason(event.target.value)} disabled={abandon.busy} />
						<div className="change-actions__buttons">
							<button type="submit" className="danger" disabled={abandon.busy || !abandonReason.trim()}>
								<Icon name="ban" />
								{abandon.busy ? "Abandoning…" : "Abandon change"}
							</button>
						</div>
						<Feedback error={abandon.error} done={abandon.done} />
					</form>
				</details>
			) : null}
		</section>
	);
}
