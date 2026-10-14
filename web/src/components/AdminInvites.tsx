import { type FormEvent, useState } from "react";
import type { ApprovedEmail } from "../api";
import { timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import type { AdminSectionProps } from "./AdminPage";
import { AdminRow, AdminRows } from "./AdminRows";
import { ConfirmButton } from "./Confirm";
import { Box, BoxHeader, BoxTitle } from "./ui/box";
import { Button } from "./ui/button";
import { Field, FieldHint, Input, Label } from "./ui/field";
import { ADD_FORM, INLINE_FIELDS, INLINE_INPUT, NOTE } from "./ui/manage";

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
				<BoxTitle id="admin-invites">Who can sign in</BoxTitle>
			</BoxHeader>
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
								question={
									`Remove ${invite.email}? If they've joined, they're signed out, their agents' tokens stop ` +
									"working, and they can't sign in again, even with the invite code, until you approve them again."
								}
								keep="Keep approved"
								busy={busy === key}
								onConfirm={() => run(key, () => actions.removeInvite(invite.email))}
							/>
						</AdminRow>
					);
				}}
			</AdminRows>
			<form className={ADD_FORM} onSubmit={approveEmail} aria-label="Approve an email">
				<div className={INLINE_FIELDS}>
					<Field className={INLINE_INPUT}>
						<Label htmlFor="admin-email">Email to approve</Label>
						<Input
							id="admin-email"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							autoComplete="off"
							aria-describedby="admin-email-hint"
						/>
					</Field>
					<Button type="submit" variant="primary" disabled={!email.trim() || busy === "approve-email"}>
						{busy === "approve-email" ? "Approving…" : "Approve"}
					</Button>
				</div>
				<FieldHint id="admin-email-hint">
					They sign in with GitHub or Google, with this email verified there. Removing one doesn't sign out someone
					already signed in.
				</FieldHint>
				{emailError ? (
					<p className={cn(NOTE, "animate-appear text-bad")} role="alert">
						{emailError}
					</p>
				) : null}
			</form>
		</Box>
	);
}
