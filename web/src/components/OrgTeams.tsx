import { type FormEvent, useState } from "react";
import type { OrgDetail } from "../api";
import { SLUG_HINT, slugProblem } from "../lib/orgs";
import { ConfirmButton } from "./Confirm";
import type { ConfirmProps, SectionProps } from "./OrgPage";

type Team = OrgDetail["teams"][number];

/** The org's teams, which roles can be granted to; to its managers, making them and choosing who's on them. */
export function TeamsSection({
	org,
	manager,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	errorFor,
}: SectionProps & ConfirmProps & { manager: boolean }) {
	const [slug, setSlug] = useState("");
	const [name, setName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [adding, setAdding] = useState<Record<string, string>>({});
	const problem = slug ? slugProblem(slug) : null;
	const rowProps = { org, manager, actions, run, busy, confirming, setConfirming, errorFor };

	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (!slug || problem) return;
		setCreateError(null);
		const ok = await run("create-team", () => actions.createTeam(org.slug, slug, name.trim()), setCreateError);
		if (ok) {
			setSlug("");
			setName("");
		}
	};

	if (!manager && org.teams.length === 0) return null;
	return (
		<section className="box" aria-labelledby="org-teams">
			<div className="box__header">
				<h2 id="org-teams">Teams</h2>
			</div>
			<p className="box__row muted manage__note">
				A team can be granted a role when GitHive is started on a repo, like{" "}
				<code>{`security = @${org.slug}/security`}</code>: anyone on the team when they vote counts as that role.
			</p>
			{org.teams.length === 0 ? <p className="box__row muted">No teams yet.</p> : null}
			<ul className="manage__rows">
				{org.teams.map((team) => (
					<TeamRow
						key={team.id}
						{...rowProps}
						team={team}
						adding={adding[team.slug]}
						setAdding={(handle) => setAdding({ ...adding, [team.slug]: handle })}
					/>
				))}
			</ul>
			{manager ? (
				<form className="box__body manage__form" onSubmit={create}>
					<div className="manage__inline">
						<label className="sr-only" htmlFor="new-team-slug">
							Team name
						</label>
						<input
							id="new-team-slug"
							type="text"
							value={slug}
							onChange={(event) => setSlug(event.target.value.toLowerCase())}
							placeholder="security"
							autoComplete="off"
							spellCheck={false}
						/>
						<label className="sr-only" htmlFor="new-team-name">
							Display name
						</label>
						<input
							id="new-team-name"
							type="text"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Display name (optional)"
							autoComplete="off"
						/>
						<button type="submit" className="accent" disabled={!slug || !!problem || busy === "create-team"}>
							New team
						</button>
					</div>
					<p className="manage__hint">
						<NewTeamHint orgSlug={org.slug} slug={slug} problem={problem} />
					</p>
					{createError ? (
						<p className="error manage__note" role="alert">
							{createError}
						</p>
					) : null}
				</form>
			) : null}
		</section>
	);
}

/** Under the new team's name: what's wrong with it, how it will be granted, or what a name may be. */
function NewTeamHint({ orgSlug, slug, problem }: { orgSlug: string; slug: string; problem: string | null }) {
	if (problem) return <span className="error">{problem}</span>;
	if (slug) return <>{`Granted as @${orgSlug}/${slug}.`}</>;
	return <>{SLUG_HINT}</>;
}

interface TeamRowProps extends SectionProps, ConfirmProps {
	manager: boolean;
	team: Team;
	/** The member chosen to add to this team, if any. */
	adding: string | undefined;
	setAdding(handle: string): void;
}

function TeamRow({
	org,
	manager,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	errorFor,
	team,
	adding,
	setAdding,
}: TeamRowProps) {
	const key = `team:${team.slug}`;
	const others = org.members.map((member) => member.handle).filter((handle) => !team.members.includes(handle));
	const addChosen = () =>
		run(key, () => actions.addTeamMember(org.slug, team.slug, adding!)).then((ok) => ok && setAdding(""));

	return (
		<li className="box__row manage__team">
			<div className="manage__row">
				<div className="manage__row-main">
					<code>
						@{org.slug}/{team.slug}
					</code>
					{team.name ? <span className="muted">{team.name}</span> : null}
				</div>
				{manager ? (
					<ConfirmButton
						id={`delete:${team.slug}`}
						confirming={confirming}
						setConfirming={setConfirming}
						label="Delete team"
						question={`Delete @${org.slug}/${team.slug}? Roles granted to it stop counting its members.`}
						busy={busy === key}
						onConfirm={() => run(key, () => actions.deleteTeam(org.slug, team.slug))}
					/>
				) : null}
			</div>
			<div className="manage__team-members">
				{team.members.length === 0 ? <span className="muted manage__note">No one yet.</span> : null}
				{team.members.map((handle) => (
					<span key={handle} className="manage__chip">
						{handle}
						{manager ? (
							<button
								type="button"
								aria-label={`Take ${handle} off @${org.slug}/${team.slug}`}
								disabled={busy === key}
								onClick={() => run(key, () => actions.removeTeamMember(org.slug, team.slug, handle))}
							>
								×
							</button>
						) : null}
					</span>
				))}
			</div>
			{manager && others.length ? (
				<div className="manage__inline">
					<label className="sr-only" htmlFor={`team-add-${team.slug}`}>
						Add to @{org.slug}/{team.slug}
					</label>
					<select id={`team-add-${team.slug}`} value={adding ?? ""} onChange={(event) => setAdding(event.target.value)}>
						<option value="">Add a member…</option>
						{others.map((handle) => (
							<option key={handle} value={handle}>
								{handle}
							</option>
						))}
					</select>
					<button type="button" className="manage__small" disabled={!adding || busy === key} onClick={addChosen}>
						Add
					</button>
				</div>
			) : null}
			{errorFor(key)}
		</li>
	);
}
