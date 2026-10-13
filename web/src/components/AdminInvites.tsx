import { type FormEvent, useState } from "react";
import type { ApprovedEmail } from "../api";
import { timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import type { AdminSectionProps } from "./AdminPage";
import { AdminRow, AdminRows } from "./AdminRows";
import { ConfirmButton } from "./Confirm";
import { Box, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { FieldHint, Input } from "./ui/field";
import { INLINE, INLINE_INPUT, NOTE, STACK, TITLE } from "./ui/manage";

/** The emails approved to sign in, with a form to approve another and a way to remove each. */
export function AdminInvites({
	invites,
	actions,
	run,
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
		<Box aria-labelledby="admin-invites">
			<BoxHeader>
				<h2 id="admin-invites" className={TITLE}>
					Who can sign in
				</h2>
			</BoxHeader>
			<form className={cn("px-0.5 py-4", STACK)} onSubmit={approveEmail}>
				<div className={INLINE}>
					<label htmlFor="admin-email" className="sr-only">
						Email to approve
					</label>
					<Input
						id="admin-email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						placeholder="person@example.com"
						className={INLINE_INPUT}
						autoComplete="off"
					/>
					<Button type="submit" variant="primary" disabled={!email.trim() || busy === "approve-email"}>
						{busy === "approve-email" ? "Approving…" : "Approve an email"}
					</Button>
				</div>
				<FieldHint>
					They sign in with GitHub or Google, with this email verified there. Removing one doesn't sign out someone
					already signed in.
				</FieldHint>
				{emailError ? (
					<p className={cn(NOTE, "animate-appear text-bad")} role="alert">
						{emailError}
					</p>
				) : null}
			</form>
			<AdminRows items={invites} keyOf={(invite) => invite.email} empty="Nobody is approved yet.">
				{(invite, arrived) => {
					const key = `invite:${invite.email}`;
					return (
						<AdminRow
							arrived={arrived}
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
								onConfirm={() => run(key, () => actions.removeInvite(invite.email))}
							/>
						</AdminRow>
					);
				}}
			</AdminRows>
		</Box>
	);
}
