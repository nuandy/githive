import { type FormEvent, useState } from "react";
import type { HostedUser } from "../api";
import { timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import type { AdminSectionProps } from "./AdminPage";
import { AdminRow, AdminRows } from "./AdminRows";
import { ConfirmButton } from "./Confirm";
import { Box, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { FieldHint, Input } from "./ui/field";
import { INLINE, INLINE_INPUT, NOTE, STACK, TITLE } from "./ui/manage";

/** Who may start GitHive's hosted agents, with a form to allow another and a way to remove each. */
export function AdminHosted({
	hosted,
	actions,
	run,
	errorFor,
	busy,
	confirming,
	setConfirming,
	now,
}: AdminSectionProps & { hosted: HostedUser[] | undefined }) {
	const [handle, setHandle] = useState("");
	const [handleError, setHandleError] = useState<string | null>(null);

	const allowPerson = async (event: FormEvent) => {
		event.preventDefault();
		if (!handle.trim()) return;
		setHandleError(null);
		if (await run("allow-hosted", () => actions.allowHosted(handle.trim()), setHandleError)) setHandle("");
	};

	return (
		<Box aria-labelledby="admin-hosted">
			<BoxHeader>
				<h2 id="admin-hosted" className={TITLE}>
					Hosted agents
				</h2>
			</BoxHeader>
			<form className={cn("px-0.5 py-4", STACK)} onSubmit={allowPerson}>
				<FieldHint>
					GitHive's hosted agents (build, request_review) run on GitHive's model account, so only the people listed here
					can start them.
				</FieldHint>
				<div className={INLINE}>
					<label htmlFor="admin-hosted-handle" className="sr-only">
						Handle to allow
					</label>
					<Input
						id="admin-hosted-handle"
						type="text"
						value={handle}
						onChange={(event) => setHandle(event.target.value)}
						placeholder="handle"
						className={INLINE_INPUT}
						autoComplete="off"
						spellCheck={false}
					/>
					<Button type="submit" variant="primary" disabled={!handle.trim() || busy === "allow-hosted"}>
						{busy === "allow-hosted" ? "Allowing…" : "Allow a person"}
					</Button>
				</div>
				<FieldHint>By their handle; they need to have signed in once.</FieldHint>
				{handleError ? (
					<p className={cn(NOTE, "animate-appear text-bad")} role="alert">
						{handleError}
					</p>
				) : null}
			</form>
			<AdminRows items={hosted} keyOf={(person) => person.handle} empty="Nobody may start hosted agents yet.">
				{(person, arrived) => {
					const key = `hosted:${person.handle}`;
					return (
						<AdminRow
							arrived={arrived}
							key={person.handle}
							name={person.handle}
							detail={
								<>
									allowed by {person.grantedBy} · {timeAgo(person.createdAt, now)}
								</>
							}
							error={errorFor(key)}
						>
							<ConfirmButton
								id={key}
								confirming={confirming}
								setConfirming={setConfirming}
								label="Remove"
								question={`Remove ${person.handle}? They can't start GitHive's hosted agents until you allow them again.`}
								keep={`Keep ${person.handle}`}
								busy={busy === key}
								onConfirm={() => run(key, () => actions.disallowHosted(person.handle))}
							/>
						</AdminRow>
					);
				}}
			</AdminRows>
		</Box>
	);
}
