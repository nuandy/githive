import { type FormEvent, useState } from "react";
import type { RepoSnapshot, VoteInput } from "../api";
import { messageOf } from "../lib/errors";
import { shortSha } from "../lib/model";
import type { Claim } from "../lib/claimStatus";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { Fold } from "./ui/collapse";
import { Label, NativeSelect, Textarea } from "./ui/field";

export interface VoteApi {
	vote(repo: string, change: string, vote: VoteInput): Promise<unknown>;
}

/** Brings the vote form's field into view, ready to type in; at once when motion is reduced. */
export function jumpToVoteForm() {
	const field = document.getElementById("vote-evidence");
	if (!field) return;
	const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	field.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
	field.focus({ preventScroll: true });
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
	className,
}: {
	repo: string;
	claim: Claim;
	policy: RepoSnapshot["policy"];
	api: VoteApi;
	className?: string;
}) {
	const roles = voteRoles(policy);
	const [role, setRole] = useState(roles[0] ?? "review");
	const [verdict, setVerdict] = useState<Verdict>("approve");
	const [evidence, setEvidence] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [done, setDone] = useState<string>();
	// While a message folds away, it still says what it said.
	const [lastError, setLastError] = useState(error);
	if (error && error !== lastError) setLastError(error);
	const [lastDone, setLastDone] = useState(done);
	if (done && done !== lastDone) setLastDone(done);
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
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form
			className={cn("min-w-0 rounded-md border border-border bg-card", className)}
			aria-labelledby="vote-title"
			onSubmit={submit}
		>
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 rounded-t-md border-b border-border bg-surface-2 px-4 py-2.5">
				<h2 id="vote-title" className="text-body-sm">
					Review changes
				</h2>
				<span className="text-muted-foreground">
					on <code>{shortSha(head)}</code>
				</span>
			</div>
			<div className="grid gap-2 px-4 pt-3.5 pb-4">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<Label htmlFor="vote-role">Vote as</Label>
					<NativeSelect id="vote-role" value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
						{roles.map((option) => (
							<option key={option} value={option}>
								{option} reviewer
							</option>
						))}
					</NativeSelect>
				</div>
				<VerdictChoice
					verdict={verdict}
					setVerdict={setVerdict}
					blocks={policy.vetoes.includes(role)}
					disabled={busy}
				/>
				<Label htmlFor="vote-evidence">What you checked</Label>
				<Textarea
					id="vote-evidence"
					rows={3}
					required
					value={evidence}
					onChange={(event) => setEvidence(event.target.value)}
					placeholder="What you looked at, and what you found"
					disabled={busy}
				/>
				{/* A message unfolds under the field, and folds away as the next try starts; the fold takes the grid's gap
				    above it in with it. */}
				<Fold open={!!error} className="-mt-2">
					<p className={cn(FEEDBACK, "text-bad")} role="alert">
						{error ?? lastError}
					</p>
				</Fold>
				<Fold open={!!done} className="-mt-2">
					<p className={cn(FEEDBACK, "text-good")} role="status">
						{done ?? lastDone}
					</p>
				</Fold>
				<div className="flex justify-end">
					<Button type="submit" variant={verdict === "approve" ? "go" : "danger"} disabled={busy || !evidence.trim()}>
						<Icon name={verdict === "approve" ? "check" : "x"} />
						{busy ? "Submitting…" : "Submit vote"}
					</Button>
				</div>
			</div>
		</form>
	);
}

const FEEDBACK = "m-0 pt-2 text-ui wrap-anywhere";

type Verdict = "approve" | "reject";

/** Approve, or request changes, which blocks the merge when voting as a veto role. */
function VerdictChoice(props: {
	verdict: Verdict;
	setVerdict: (verdict: Verdict) => void;
	blocks: boolean;
	disabled: boolean;
}) {
	const { verdict, setVerdict, blocks, disabled } = props;
	const options: { value: Verdict; title: string; detail: string }[] = [
		{ value: "approve", title: "Approve", detail: "These changes can merge." },
		{
			value: "reject",
			title: "Request changes",
			detail: blocks ? "Blocks the merge." : "The agent should address this before merging.",
		},
	];
	return (
		<fieldset className="mx-0 my-1 grid gap-1.5 border-0 p-0" disabled={disabled}>
			<legend className="sr-only">Verdict</legend>
			{options.map((option) => (
				<label
					key={option.value}
					className={cn(
						"flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 font-normal",
						"transition-[border-color,background-color] duration-fast ease-out",
						verdict === option.value ? "border-link bg-link-soft" : "border-border",
					)}
				>
					<input
						className="mt-0.75 mr-0.75 mb-0 ml-1.25"
						type="radio"
						name="verdict"
						value={option.value}
						checked={verdict === option.value}
						onChange={() => setVerdict(option.value)}
					/>
					<span className="grid gap-px">
						<strong>{option.title}</strong>
						<span className="text-meta text-muted-foreground">{option.detail}</span>
					</span>
				</label>
			))}
		</fieldset>
	);
}
