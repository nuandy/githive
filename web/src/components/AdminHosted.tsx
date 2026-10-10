import { type FormEvent, useState } from "react";
import type { HostedUser } from "../api";
import { timeAgo } from "../lib/relativeTime";
import type { AdminSectionProps } from "./AdminPage";
import { AdminRow, AdminRows } from "./AdminRows";
import { ConfirmButton } from "./Confirm";

/** Who may start GitHive's hosted agents, with a form to allow another and a way to remove each. */
export function AdminHosted({
	hosted,
	actions,
	run,
	rowFailed,
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
		<section className="box" aria-labelledby="admin-hosted">
			<div className="box__header">
				<h2 id="admin-hosted">Hosted agents</h2>
			</div>
			<form className="box__body manage__form" onSubmit={allowPerson}>
				<p className="manage__hint">
					GitHive's hosted agents (build, request_review) run on GitHive's model account, so only the people listed here
					can start them.
				</p>
				<div className="manage__inline">
					<label htmlFor="admin-hosted-handle" className="sr-only">
						Handle to allow
					</label>
					<input
						id="admin-hosted-handle"
						type="text"
						value={handle}
						onChange={(event) => setHandle(event.target.value)}
						placeholder="handle"
						autoComplete="off"
						spellCheck={false}
					/>
					<button type="submit" className="accent" disabled={!handle.trim() || busy === "allow-hosted"}>
						{busy === "allow-hosted" ? "Allowing…" : "Allow a person"}
					</button>
				</div>
				<p className="manage__hint">By their handle; they need to have signed in once.</p>
				{handleError ? (
					<p className="error manage__note" role="alert">
						{handleError}
					</p>
				) : null}
			</form>
			<AdminRows items={hosted} empty="Nobody may start hosted agents yet.">
				{(person) => {
					const key = `hosted:${person.handle}`;
					return (
						<AdminRow
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
								question={`Stop ${person.handle} starting hosted agents?`}
								busy={busy === key}
								onConfirm={() => run(key, () => actions.disallowHosted(person.handle), rowFailed(key))}
							/>
						</AdminRow>
					);
				}}
			</AdminRows>
		</section>
	);
}
