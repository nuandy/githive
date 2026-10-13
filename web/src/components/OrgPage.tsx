import { type FormEvent, useState } from "react";
import type { ManageApi, OrgDetail, OrgRole } from "../api";
import { usePoll } from "../hooks/usePoll";
import { canLeave, canManage } from "../lib/orgs";
import { LEVELS, type Level } from "../lib/permissions";
import { href } from "../lib/routes";
import { useRowActions } from "../hooks/useRowActions";
import { cn } from "../lib/utils";
import { ConfirmButton } from "./Confirm";
import { Icon } from "./Icon";
import { MembersSection } from "./OrgMembers";
import { TeamsSection } from "./OrgTeams";
import { Page } from "./Page";
import { Badge } from "./ui/badge";
import { Box, BoxBody, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import { Field, FieldHint, Input, Label, NativeSelect } from "./ui/field";
import { LINE, ManageHeader, ManagePage, NOTE, ROW, ROW_MAIN, ROWS, RULED, STACK, TITLE } from "./ui/manage";

/** What the org page can do; the page refreshes after each. */
export type OrgActions = Pick<
	ManageApi,
	| "updateOrg"
	| "addMember"
	| "setRole"
	| "removeMember"
	| "cancelInvite"
	| "createTeam"
	| "deleteTeam"
	| "addTeamMember"
	| "removeTeamMember"
>;

export interface OrgViewProps {
	org: OrgDetail;
	me: { handle: string };
	actions: OrgActions;
	/** After leaving: the org is no longer yours to see in full. */
	onLeft: () => void;
}

/** What each section of the org page gets from the page: the org, its actions, and the busy and error state. */
export interface SectionProps {
	org: OrgDetail;
	actions: OrgActions;
	run: (key: string, work: () => Promise<unknown>, onError?: (text: string) => void) => Promise<boolean>;
	busy: string | null;
	errorFor: (key: string) => React.ReactNode;
}
export type ConfirmProps = { confirming: string | null; setConfirming: (id: string | null) => void };

/**
 * An organization: its repositories (those you can see); to its members, its
 * people and teams; to its owners and admins, managing them and its settings.
 * A person's own namespace is just their repositories.
 */
export function OrgView({ org, me, actions, onLeft }: OrgViewProps) {
	const manager = canManage(org.role);
	const mine = org.personal && org.slug === me.handle;
	const { run, busy, confirming, setConfirming, errorFor } = useRowActions();
	const leave = () => run("leave", () => actions.removeMember(org.slug, me.handle)).then((ok) => ok && onLeft());
	const confirm = { confirming, setConfirming };

	return (
		<ManagePage>
			<ManageHeader
				title={mine ? "Your repositories" : org.name || org.slug}
				lede={<OrgLede org={org} mine={mine} />}
				actions={
					org.canCreateRepos || canLeave(org) ? (
						<>
							{org.canCreateRepos ? (
								<Button asChild>
									<a href={href.newRepo(org.slug)}>
										<Icon name="plus" size={15} /> New repository
									</a>
								</Button>
							) : null}
							{canLeave(org) ? (
								<ConfirmButton
									id="leave"
									{...confirm}
									label="Leave"
									question={`Leave ${org.slug}?`}
									busy={busy === "leave"}
									onConfirm={leave}
								/>
							) : null}
						</>
					) : null
				}
			/>
			{errorFor("leave")}

			<OrgRepos org={org} />

			{!org.personal && org.role ? (
				<>
					<MembersSection
						org={org}
						me={me}
						manager={manager}
						actions={actions}
						run={run}
						busy={busy}
						{...confirm}
						errorFor={errorFor}
					/>
					<TeamsSection
						org={org}
						manager={manager}
						actions={actions}
						run={run}
						busy={busy}
						{...confirm}
						errorFor={errorFor}
					/>
					{manager ? <SettingsSection org={org} actions={actions} run={run} busy={busy} errorFor={errorFor} /> : null}
				</>
			) : null}
		</ManagePage>
	);
}

/** "an admin", "an owner" or "a member". */
function roleWithArticle(role: OrgRole) {
	if (role === "admin") return "an admin";
	return `a${role === "owner" ? "n owner" : " member"}`;
}

/** The line under the org's name: whose repositories these are, or your part in the org. */
function OrgLede({ org, mine }: { org: OrgDetail; mine: boolean }) {
	if (mine)
		return (
			<>
				Repositories under your name, <code>{org.slug}/&lt;name&gt;</code>. Add collaborators to one in its Settings.
			</>
		);
	if (org.personal) return <>{org.slug}'s repositories that you can see.</>;
	return (
		<>
			<code>{org.slug}</code>
			{org.role ? ` · you're ${roleWithArticle(org.role)}` : ""}
		</>
	);
}

function OrgRepos({ org }: { org: OrgDetail }) {
	return (
		<Box aria-labelledby="org-repos">
			<BoxHeader>
				<h2 id="org-repos" className={TITLE}>
					Repositories
				</h2>
			</BoxHeader>
			{org.repos.length === 0 ? (
				<p className={cn(LINE, "text-muted-foreground")}>
					{org.canCreateRepos ? "None yet." : "None that you can see."}
				</p>
			) : (
				<ul className={ROWS}>
					{org.repos.map((repo) => {
						const isPublic = repo.visibility === "public";
						return (
							<li key={repo.id} className={cn(RULED, ROW)}>
								<div className={ROW_MAIN}>
									<Icon name="repo" className="text-muted-foreground" />
									<a href={href.repo(repo.fullName)}>{repo.fullName}</a>
								</div>
								<Badge tone={isPublic ? "accent" : "neutral"}>{isPublic ? "Public" : "Private"}</Badge>
							</li>
						);
					})}
				</ul>
			)}
		</Box>
	);
}

const capitalized = (level: Level) => level.charAt(0).toUpperCase() + level.slice(1);

function SettingsSection({ org, actions, run, busy, errorFor }: SectionProps) {
	const [name, setName] = useState(org.name ?? "");
	const [level, setLevel] = useState<Level>(org.defaultPermission);
	const [membersCreate, setMembersCreate] = useState(org.membersCanCreateRepos);
	const [saved, setSaved] = useState(false);
	const changed =
		name !== (org.name ?? "") || level !== org.defaultPermission || membersCreate !== org.membersCanCreateRepos;

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setSaved(false);
		const ok = await run("settings", () =>
			actions.updateOrg(org.slug, {
				name: name.trim() || null,
				default_permission: level,
				members_can_create_repos: membersCreate,
			}),
		);
		if (ok) setSaved(true);
	};

	return (
		<Box asChild>
			<form onSubmit={save} aria-labelledby="org-settings">
				<BoxHeader>
					<h2 id="org-settings" className={TITLE}>
						Settings
					</h2>
				</BoxHeader>
				<BoxBody className={STACK}>
					<Field>
						<Label htmlFor="org-name" className="text-body-sm">
							Display name
						</Label>
						<Input
							id="org-name"
							type="text"
							className="w-full max-w-120"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder={org.slug}
							autoComplete="off"
						/>
					</Field>
					<Field>
						<Label htmlFor="org-default" className="text-body-sm">
							What members can do in its repositories
						</Label>
						<NativeSelect
							id="org-default"
							className="w-full max-w-120"
							value={level}
							onChange={(event) => setLevel(event.target.value as Level)}
						>
							{LEVELS.map((option) => (
								<option key={option} value={option}>
									{capitalized(option)}
								</option>
							))}
						</NativeSelect>
						<FieldHint>
							Owners and admins can always do everything. Collaborators added to one repository get what they're given
							there.
						</FieldHint>
					</Field>
					<Label className="flex cursor-pointer items-start gap-2 font-normal">
						{/* The browser's own margins about a checkbox. */}
						<input
							type="checkbox"
							className="mt-0.75 mr-0.75 mb-0.75 ml-1"
							checked={membersCreate}
							onChange={(event) => setMembersCreate(event.target.checked)}
						/>
						<span>Members can make repositories</span>
					</Label>
					{errorFor("settings")}
					{saved && !changed ? (
						<p className={cn(NOTE, "animate-appear")} role="status">
							Saved.
						</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button type="submit" variant="primary" disabled={!changed || busy === "settings"}>
							{busy === "settings" ? "Saving…" : "Save"}
						</Button>
					</div>
				</BoxBody>
			</form>
		</Box>
	);
}

/** Why the org isn't shown yet: still loading, or the error that stopped it. */
function OrgUnavailable({ slug, error }: { slug: string; error: string | undefined }) {
	if (!error)
		return (
			<p className="my-3.75 py-8 text-center text-muted-foreground" role="status">
				Loading {slug}…
			</p>
		);
	return (
		<Box asChild>
			<Empty className="animate-fade">
				<h2>Can't show {slug}</h2>
				<p>
					{error} <a href={href.orgs()}>Your organizations</a>.
				</p>
			</Empty>
		</Box>
	);
}

/** The page, with its data. */
export function OrgPage({ slug, me, manage }: { slug: string; me: { handle: string }; manage: ManageApi }) {
	const org = usePoll(`org:${slug}`, () => manage.org(slug), 60_000);
	const refreshAfter =
		<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) =>
		async (...args: Args) => {
			const result = await work(...args);
			org.refresh();
			return result;
		};
	const actions: OrgActions = {
		updateOrg: refreshAfter(manage.updateOrg),
		addMember: refreshAfter(manage.addMember),
		setRole: refreshAfter(manage.setRole),
		removeMember: refreshAfter(manage.removeMember),
		cancelInvite: refreshAfter(manage.cancelInvite),
		createTeam: refreshAfter(manage.createTeam),
		deleteTeam: refreshAfter(manage.deleteTeam),
		addTeamMember: refreshAfter(manage.addTeamMember),
		removeTeamMember: refreshAfter(manage.removeTeamMember),
	};
	if (!org.data)
		return (
			<Page id="main">
				<OrgUnavailable slug={slug} error={org.error} />
			</Page>
		);
	return (
		<OrgView
			org={org.data}
			me={me}
			actions={actions}
			onLeft={() => {
				window.location.hash = href.orgs();
			}}
		/>
	);
}
