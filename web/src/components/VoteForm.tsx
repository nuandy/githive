import { type FormEvent, useState } from "react";
import type { RepoSnapshot, VoteInput } from "../api";
import { messageOf } from "../lib/errors";
import { shortSha } from "../lib/model";
import type { Claim, Vote } from "../lib/claimStatus";
import {
	blockingRolesFor,
	holdersWords,
	listed,
	type Reader,
	rolesBeyondReader,
	startingRole,
	voteRoles,
} from "../lib/decision";
import { roleName } from "../lib/roles";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { Fold } from "./ui/collapse";
import { FieldHint, Label, NativeSelect, Textarea } from "./ui/field";

export interface VoteApi {
	vote(repo: string, change: string, vote: VoteInput): Promise<unknown>;
}

/** What a person decides: approve, send it back, or block it as a role that can. */
type Choice = "approve" | "request" | "block";

/** The vote a choice casts, as `role`: a request for changes is a reviewer's, a block the blocking role's. */
function voteOf(choice: Choice, role: string, blocking: boolean): Pick<VoteInput, "role" | "verdict"> {
	if (choice === "approve") return { role, verdict: "approve" };
	if (choice === "block") return { role, verdict: "reject" };
	return { role: blocking ? "review" : role, verdict: "reject" };
}

/** "You approved 4e6df04", "You asked for changes on 4e6df04", "You blocked 4e6df04 as security". */
function votedWords(vote: Pick<Vote, "role" | "verdict" | "commit">, blocks: boolean): string {
	const sha = shortSha(vote.commit);
	if (vote.verdict === "approve") return `You approved ${sha}${vote.role === "review" ? "" : ` as ${vote.role}`}`;
	return blocks ? `You blocked ${sha} as ${vote.role}` : `You asked for changes on ${sha}`;
}

/**
 * A person's vote on a change's current commit, from its page. It is stamped with their verified identity, counts like
 * any reviewer's, and answers an agent's question about the change. It offers the roles the reader may vote as (all of
 * them, each said to be theirs or not, when that can't be told), then a verdict with what it does. Once they've voted on
 * this commit it folds to what they voted, with a way to change it. A refusal shows the server's words.
 */
export function VoteForm({
	repo,
	claim,
	policy,
	api,
	reader = {},
	mine,
	initialRole,
	className,
}: {
	repo: string;
	claim: Claim;
	/** The policy of the branch the change lands on. */
	policy: RepoSnapshot["policy"];
	api: VoteApi;
	/** Who is voting, which decides the roles offered. */
	reader?: Reader;
	/** The reader's own latest vote on the head, if they gave one. */
	mine?: Vote | undefined;
	/** The role chosen at first (tests). */
	initialRole?: string;
	className?: string;
}) {
	const { roles, exact } = voteRoles(policy, claim, reader);
	// As the role it waits on, when that's the reader's: the Inbox's "Vote as payments" opens it as payments.
	const [role, setRole] = useState(initialRole ?? startingRole(roles, claim.approval.awaiting) ?? "review");
	const [choice, setChoice] = useState<Choice | null>(null);
	const [evidence, setEvidence] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	// The vote just cast, until the page's votes bring it, and the head the reader chose to vote on again.
	const [cast, setCast] = useState<Pick<Vote, "role" | "verdict" | "commit">>();
	const [reopened, setReopened] = useState<string | null>(null);
	// While a message folds away, it still says what it said.
	const [lastError, setLastError] = useState(error);
	if (error && error !== lastError) setLastError(error);
	const missing = busy ? undefined : stillNeeds(choice, evidence, !!claim.attention);
	const [lastMissing, setLastMissing] = useState(missing);
	if (missing && missing !== lastMissing) setLastMissing(missing);
	if (!claim.head) return null;
	const head = claim.head;
	const blockingRoles = [...blockingRolesFor(policy, claim.paths), ...(claim.approval.awaiting ?? [])];
	const blocking = blockingRoles.includes(role);
	const voted = (cast?.commit === head ? cast : undefined) ?? (mine?.commit === head ? mine : undefined);

	if (voted && reopened !== head)
		return (
			<div
				id="vote"
				tabIndex={-1}
				className={cn(
					"flex min-w-0 scroll-mt-[calc(var(--topbar-height)+12px)] flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-card px-4 py-2.5",
					className,
				)}
			>
				<Icon
					name={voted.verdict === "approve" ? "check" : "x"}
					className={voted.verdict === "approve" ? "text-good" : "text-bad"}
				/>
				<span role="status">{votedWords(voted, blockingRoles.includes(voted.role))}</span>
				<span aria-hidden="true" className="text-muted-foreground">
					·
				</span>
				<Button
					variant="link"
					className="p-0"
					onClick={() => {
						setReopened(head);
						setChoice(null);
					}}
				>
					Change
				</Button>
			</div>
		);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!choice || !evidence.trim() || busy) return;
		setBusy(true);
		setError(undefined);
		const vote = { ...voteOf(choice, role, blocking), evidence: evidence.trim() };
		try {
			await api.vote(repo, claim.change, vote);
			setCast({ ...vote, commit: head });
			setReopened(null);
			setChoice(null);
			setEvidence("");
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};

	const unknown = exact ? [] : roles.filter((each) => each.granted !== true);
	const beyond = rolesBeyondReader(policy, claim, reader);
	return (
		<form
			id="vote"
			tabIndex={-1}
			className={cn(
				"min-w-0 scroll-mt-[calc(var(--topbar-height)+12px)] rounded-md border border-border bg-card",
				className,
			)}
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
				{beyond.map(({ role: waitsOn, holders }) => (
					<p key={waitsOn} className="m-0 mb-1 flex max-w-measure items-start gap-2 text-ui text-muted-foreground">
						<Icon name="alert" size={14} className="mt-0.75 shrink-0" />
						<span>
							This change waits on a {waitsOn} vote, which you can't give.
							{holders.length ? ` ${capitalized(holdersWords(holders, reader))} can.` : null}
						</span>
					</p>
				))}
				{roles.length > 1 ? (
					<div className="grid gap-1.5">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
							<Label htmlFor="vote-role">Vote as</Label>
							<NativeSelect
								id="vote-role"
								value={role}
								onChange={(event) => {
									setRole(event.target.value);
									if (choice === "block") setChoice(null);
								}}
								disabled={busy}
								aria-describedby={unknown.length ? "vote-role-hint" : undefined}
							>
								{roles.map((option) => (
									<option key={option.role} value={option.role}>
										{roleName(option.role)}
									</option>
								))}
							</NativeSelect>
						</div>
						{unknown.length ? (
							<FieldHint id="vote-role-hint" className="max-w-measure text-meta">
								{rolesHint(roles, unknown, policy)}
							</FieldHint>
						) : null}
					</div>
				) : null}
				<VerdictChoice
					choice={choice}
					setChoice={setChoice}
					role={role}
					blocking={blocking}
					agent={claim.agent}
					required={claim.approval.required}
					disabled={busy}
				/>
				<Label htmlFor="vote-evidence">
					{claim.attention ? `Your answer to ${claim.attention.agent}` : "What you checked"}
				</Label>
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
				<div className="grid justify-items-end">
					<Button
						type="submit"
						variant={choice ? SUBMIT[choice].variant : "default"}
						disabled={busy || !!missing}
						aria-describedby={missing ? "vote-missing" : undefined}
					>
						{choice ? <Icon name={SUBMIT[choice].icon} /> : null}
						{busy ? "Submitting…" : "Submit vote"}
					</Button>
					<Fold open={!!missing}>
						<p id="vote-missing" className="m-0 pt-1.5 text-meta text-muted-foreground">
							{missing ?? lastMissing}
						</p>
					</Fold>
				</div>
			</div>
		</form>
	);
}

/** Which roles are the reader's, when that can't be told for each: "payments counts only from @acme/payments". */
function rolesHint(
	roles: { role: string; granted: boolean | null }[],
	unknown: { role: string; granted: boolean | null }[],
	policy: RepoSnapshot["policy"],
): string {
	const theirs = roles.filter((each) => each.granted).map((each) => each.role);
	const counts = unknown.map((each) => `${each.role} counts only from ${listed(policy.grants?.[each.role] ?? [])}`);
	return `Yours: ${listed(theirs)}. ${counts.join("; ")}.`;
}

const FEEDBACK = "m-0 pt-2 text-ui wrap-anywhere";

const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** The submit button once a verdict is chosen: green to approve, red to send it back or block it. */
const SUBMIT = {
	approve: { variant: "go", icon: "check" },
	request: { variant: "danger", icon: "x" },
	block: { variant: "danger", icon: "ban" },
} as const;

/** What a vote still needs before it can be sent, as a sentence; nothing once it can be. */
function stillNeeds(choice: Choice | null, evidence: string, answering: boolean): string | undefined {
	const said = !!evidence.trim();
	if (choice && said) return undefined;
	if (said) return "Choose a verdict.";
	if (choice) return answering ? "Write your answer." : "Say what you checked.";
	return answering ? "Choose a verdict and write your answer." : "Choose a verdict and say what you checked.";
}

/** Approve, request changes, or, as a role that can block, block: each with what it does to the change. */
function VerdictChoice(props: {
	choice: Choice | null;
	setChoice: (choice: Choice) => void;
	role: string;
	blocking: boolean;
	agent: string;
	required: number;
	disabled: boolean;
}) {
	const { choice, setChoice, role, blocking, agent, required, disabled } = props;
	const counts = required > 0 ? ` Your approval counts toward the ${required} it needs.` : "";
	const options: { value: Choice; title: string; detail: string }[] = [
		{
			value: "approve",
			title: "Approve",
			detail: `These changes can land.${blocking ? ` It's the ${role} approval it needs.` : counts}`,
		},
		{
			value: "request",
			title: "Request changes",
			detail: `It goes back to ${agent}, and it can't land on this push: a reviewer's request${blocking ? ", not a block" : ""}.`,
		},
	];
	if (blocking)
		options.push({
			value: "block",
			title: `Block as ${role}`,
			detail: `It can't land, whatever its approvals, until ${role} approves a later push.`,
		});
	return (
		<fieldset className="mx-0 my-1 grid gap-1.5 border-0 p-0" disabled={disabled}>
			<legend className="sr-only">Verdict</legend>
			{options.map((option) => (
				<label
					key={option.value}
					className={cn(
						"flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 font-normal",
						"transition-[border-color,background-color] duration-fast ease-out",
						choice === option.value ? "border-link bg-link-soft" : "border-border",
					)}
				>
					<input
						className="mt-0.75 mr-0.75 mb-0 ml-1.25"
						type="radio"
						name="verdict"
						value={option.value}
						checked={choice === option.value}
						onChange={() => setChoice(option.value)}
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
