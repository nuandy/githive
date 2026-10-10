import { type FormEvent, useState } from "react";
import type { ApprovedEmail } from "../api";
import { timeAgo } from "../lib/relativeTime";
import type { AdminSectionProps } from "./AdminPage";
import { AdminRow, AdminRows } from "./AdminRows";
import { ConfirmButton } from "./Confirm";

/** The emails approved to sign in, with a form to approve another and a way to remove each. */
export function AdminInvites({
	invites,
	actions,
	run,
	rowFailed,
	errorFor,
	busy,
	confirming,
	setConfirming,
	now,
}: AdminSectionProps & { invites: ApprovedEmail[] | undefined }) {
	const [email, setEmail] = useState("");
	const [emailError, setEmailError] = useState<string | null>(null);

	const approveEmail = async (event: FormEvent) => {
		event.preventDefault();
		if (!email.trim()) return;
		setEmailError(null);
		if (await run("approve-email", () => actions.approve(email.trim()), setEmailError)) setEmail("");
	};

	return (
		<section className="box" aria-labelledby="admin-invites">
			<div className="box__header">
				<h2 id="admin-invites">Who can sign in</h2>
			</div>
			<form className="box__body manage__form" onSubmit={approveEmail}>
				<div className="manage__inline">
					<label htmlFor="admin-email" className="sr-only">
						Email to approve
					</label>
					<input
						id="admin-email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						placeholder="person@example.com"
						autoComplete="off"
					/>
					<button type="submit" className="accent" disabled={!email.trim() || busy === "approve-email"}>
						{busy === "approve-email" ? "Approving…" : "Approve an email"}
					</button>
				</div>
				<p className="manage__hint">
					They sign in with GitHub or Google, with this email verified there. Removing one doesn't sign out someone
					already signed in.
				</p>
				{emailError ? (
					<p className="error manage__note" role="alert">
						{emailError}
					</p>
				) : null}
			</form>
			<AdminRows items={invites} empty="Nobody is approved yet.">
				{(invite) => {
					const key = `invite:${invite.email}`;
					return (
						<AdminRow
							key={invite.email}
							name={invite.email}
							detail={
								<>
									approved by {invite.invitedBy} · {timeAgo(invite.createdAt, now)}
								</>
							}
							error={errorFor(key)}
						>
							<ConfirmButton
								id={key}
								confirming={confirming}
								setConfirming={setConfirming}
								label="Remove"
								question={`Stop ${invite.email} signing in?`}
								busy={busy === key}
								onConfirm={() => run(key, () => actions.removeInvite(invite.email), rowFailed(key))}
							/>
						</AdminRow>
					);
				}}
			</AdminRows>
		</section>
	);
}
