import { type FormEvent, useState } from "react";
import type { OrgDetail } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useStagger } from "../hooks/useStagger";
import { SLUG_HINT, slugProblem } from "../lib/orgs";
import { cn } from "../lib/utils";
import { ConfirmButton } from "./Confirm";
import type { ConfirmProps, SectionProps, UndoProps } from "./OrgPage";
import { Box, BoxHeader, BoxTitle } from "./ui/box";
import { Button } from "./ui/button";
import { Field, FieldHint, Input, Label, NativeSelect } from "./ui/field";
import { UndoLine } from "./ui/undo-line";
import {
	ADD_FORM,
	INLINE_FIELDS,
	INLINE_INPUT,
	LINE,
	NOTE,
	ROW,
	ROW_ACTIONS,
	ROW_MAIN,
	ROWS,
	RULED,
} from "./ui/manage";

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
	undo,
}: SectionProps & ConfirmProps & UndoProps & { manager: boolean }) {
	const [slug, setSlug] = useState("");
	const [name, setName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [adding, setAdding] = useState<Record<string, string>>({});
	const problem = slug ? slugProblem(slug) : null;
	const rowProps = { org, manager, actions, run, busy, confirming, setConfirming, errorFor, undo };
	// A team made since the page showed fades in.
	const arrived = useArrivals(org.teams.map((team) => team.slug));
	const staggers = useStagger(org.teams.length > 0);

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
		<Box aria-labelledby="org-teams">
			<BoxHeader>
				<BoxTitle id="org-teams">Teams</BoxTitle>
			</BoxHeader>
			<p className={cn(LINE, NOTE, "text-muted-foreground")}>
				A team can be granted a role when GitHive is started on a repo, like{" "}
				<code>{`security = @${org.slug}/security`}</code>: anyone on the team when they vote counts as that role.
			</p>
			{org.teams.length === 0 ? <p className={cn(LINE, "text-muted-foreground")}>No teams yet.</p> : null}
			<ul className={cn(ROWS, staggers && "stagger")}>
				{org.teams.map((team) => (
					<TeamRow
						key={team.id}
						{...rowProps}
						arrived={arrived(team.slug)}
						team={team}
						adding={adding[team.slug]}
						setAdding={(handle) => setAdding({ ...adding, [team.slug]: handle })}
					/>
				))}
			</ul>
			{manager ? (
				<form className={ADD_FORM} onSubmit={create} aria-label="Make a team">
					<div className={INLINE_FIELDS}>
						<Field className={INLINE_INPUT}>
							<Label htmlFor="new-team-slug">Team name</Label>
							<Input
								id="new-team-slug"
								type="text"
								value={slug}
								onChange={(event) => setSlug(event.target.value.toLowerCase())}
								autoComplete="off"
								spellCheck={false}
								aria-invalid={problem ? true : undefined}
								aria-describedby="new-team-slug-hint"
							/>
						</Field>
						<Field className={INLINE_INPUT}>
							<Label htmlFor="new-team-name">Display name (optional)</Label>
							<Input
								id="new-team-name"
								type="text"
								value={name}
								onChange={(event) => setName(event.target.value)}
								autoComplete="off"
							/>
						</Field>
						<Button type="submit" variant="primary" disabled={!slug || !!problem || busy === "create-team"}>
							New team
						</Button>
					</div>
					<NewTeamHint orgSlug={org.slug} slug={slug} problem={problem} />
					{createError ? (
						<p className={cn(NOTE, "animate-appear text-bad")} role="alert">
							{createError}
						</p>
					) : null}
				</form>
			) : null}
		</Box>
	);
}

/**
 * Under the new team's name: what's wrong with it, how it will be granted, or what a name may be. As it says something
 * else (a problem, say), it fades in.
 */
function NewTeamHint({ orgSlug, slug, problem }: { orgSlug: string; slug: string; problem: string | null }) {
	const say = problem ?? (slug ? "granted" : "rules");
	const changed = useChanged(say);
	let said: React.ReactNode = SLUG_HINT;
	if (problem) said = <span className="text-bad">{problem}</span>;
	else if (slug) said = `Granted as @${orgSlug}/${slug}.`;
	return (
		<FieldHint key={say} id="new-team-slug-hint" className={cn(changed && "animate-fade")}>
			{said}
		</FieldHint>
	);
}

interface TeamRowProps extends SectionProps, ConfirmProps, UndoProps {
	manager: boolean;
	team: Team;
	/** Made since the page showed: it fades in. */
	arrived: boolean;
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
	undo,
	team,
	arrived,
	adding,
	setAdding,
}: TeamRowProps) {
	const key = `team:${team.slug}`;
	const name = `@${org.slug}/${team.slug}`;
	const takeOff = (handle: string) =>
		run(key, () => actions.removeTeamMember(org.slug, team.slug, handle)).then(
			(ok) =>
				ok &&
				undo.offer(key, { done: `Took ${handle} off ${name}.`, undone: `${handle} is back on ${name}.` }, () =>
					actions.addTeamMember(org.slug, team.slug, handle),
				),
		);
	const others = org.members.map((member) => member.handle).filter((handle) => !team.members.includes(handle));
	const addChosen = () =>
		run(key, () => actions.addTeamMember(org.slug, team.slug, adding!)).then((ok) => ok && setAdding(""));

	return (
		<li className={cn(RULED, "grid gap-2", arrived && "animate-appear")}>
			<div className={ROW}>
				<div className={ROW_MAIN}>
					<code>
						@{org.slug}/{team.slug}
					</code>
					{team.name ? <span className="text-muted-foreground">{team.name}</span> : null}
				</div>
				{manager ? (
					<div className={ROW_ACTIONS}>
						<ConfirmButton
							id={`delete:${team.slug}`}
							confirming={confirming}
							setConfirming={setConfirming}
							label="Delete team"
							question={`Delete ${name}? Roles granted to it stop counting its members.`}
							keep="Keep team"
							busy={busy === key}
							onConfirm={() => run(key, () => actions.deleteTeam(org.slug, team.slug))}
						/>
					</div>
				) : null}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{team.members.length === 0 ? <span className={cn(NOTE, "text-muted-foreground")}>No one yet.</span> : null}
				{team.members.map((handle) => (
					<span
						key={handle}
						className="inline-flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-2.5 text-ui"
					>
						{handle}
						{manager ? (
							<Button
								variant="ghost"
								className="border-0 px-1.5 py-0 text-ui leading-4.5"
								aria-label={`Take ${handle} off ${name}`}
								disabled={busy === key}
								onClick={() => takeOff(handle)}
							>
								×
							</Button>
						) : null}
					</span>
				))}
			</div>
			{manager && others.length ? (
				<div className={INLINE_FIELDS}>
					<Field>
						<Label htmlFor={`team-add-${team.slug}`} className="text-ui">
							Add to {name}
						</Label>
						<NativeSelect
							id={`team-add-${team.slug}`}
							value={adding ?? ""}
							onChange={(event) => setAdding(event.target.value)}
						>
							<option value="">Choose someone…</option>
							{others.map((handle) => (
								<option key={handle} value={handle}>
									{handle}
								</option>
							))}
						</NativeSelect>
					</Field>
					<Button disabled={!adding || busy === key} onClick={addChosen}>
						Add
					</Button>
				</div>
			) : null}
			<UndoLine undo={undo} where={key} />
			{errorFor(key)}
		</li>
	);
}
