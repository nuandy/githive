import { type FormEvent, useState } from "react";
import type { ManageApi, OrgDetail, OrgRole } from "../api";
import { usePoll } from "../hooks/usePoll";
import { canLeave, canManage } from "../lib/orgs";
import { LEVELS, type Level } from "../lib/permissions";
import { href } from "../lib/routes";
import { ConfirmButton, messageOf } from "./Confirm";
import { Icon } from "./Icon";
import { MembersSection } from "./OrgMembers";
import { TeamsSection } from "./OrgTeams";
import "./Manage.css";

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
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

	/** Run one action, keyed so its row shows it's busy, and any error next to it. */
	const run = async (key: string, work: () => Promise<unknown>, onError?: (text: string) => void) => {
		setBusy(key);
		setRowError(null);
		try {
			await work();
			setConfirming(null);
			return true;
		} catch (err) {
			const showError = onError ?? ((text: string) => setRowError({ id: key, text }));
			showError(messageOf(err));
			return false;
		} finally {
			setBusy(null);
		}
	};
	const errorFor = (key: string) =>
		rowError?.id === key ? (
			<p className="error manage__note" role="alert">
				{rowError.text}
			</p>
		) : null;
	const leave = () => run("leave", () => actions.removeMember(org.slug, me.handle)).then((ok) => ok && onLeft());
	const confirm = { confirming, setConfirming };

	return (
		<main className="page manage" id="main">
			<header className="manage__header">
				<div>
					<h1>{mine ? "Your repositories" : org.name || org.slug}</h1>
					<p className="muted manage__lede">
						<OrgLede org={org} mine={mine} />
					</p>
				</div>
				<div className="manage__header-actions">
					{org.canCreateRepos ? (
						<a className="button" href={href.newRepo(org.slug)}>
							<Icon name="plus" size={15} /> New repository
						</a>
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
				</div>
			</header>
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
		</main>
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
		<section className="box" aria-labelledby="org-repos">
			<div className="box__header">
				<h2 id="org-repos">Repositories</h2>
			</div>
			{org.repos.length === 0 ? (
				<p className="box__row muted">{org.canCreateRepos ? "None yet." : "None that you can see."}</p>
			) : (
				<ul className="manage__rows">
					{org.repos.map((repo) => {
						const isPublic = repo.visibility === "public";
						return (
							<li key={repo.id} className="box__row manage__row">
								<div className="manage__row-main">
									<Icon name="repo" className="muted" />
									<a href={href.repo(repo.fullName)}>{repo.fullName}</a>
								</div>
								<span className={`pill ${isPublic ? "pill--accent" : "pill--neutral"}`}>
									{isPublic ? "Public" : "Private"}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

const capitalized = (level: Level) => level[0].toUpperCase() + level.slice(1);

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
		<form className="box" onSubmit={save} aria-labelledby="org-settings">
			<div className="box__header">
				<h2 id="org-settings">Settings</h2>
			</div>
			<div className="box__body manage__form">
				<div className="manage__field">
					<label htmlFor="org-name">Display name</label>
					<input
						id="org-name"
						type="text"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder={org.slug}
						autoComplete="off"
					/>
				</div>
				<div className="manage__field">
					<label htmlFor="org-default">What members can do in its repositories</label>
					<select id="org-default" value={level} onChange={(event) => setLevel(event.target.value as Level)}>
						{LEVELS.map((option) => (
							<option key={option} value={option}>
								{capitalized(option)}
							</option>
						))}
					</select>
					<p className="manage__hint">
						Owners and admins can always do everything. Collaborators added to one repository get what they're given
						there.
					</p>
				</div>
				<label className="manage__choice">
					<input type="checkbox" checked={membersCreate} onChange={(event) => setMembersCreate(event.target.checked)} />
					<span>Members can make repositories</span>
				</label>
				{errorFor("settings")}
				{saved && !changed ? (
					<p className="manage__note" role="status">
						Saved.
					</p>
				) : null}
				<div className="manage__actions">
					<button type="submit" className="accent" disabled={!changed || busy === "settings"}>
						{busy === "settings" ? "Saving…" : "Save"}
					</button>
				</div>
			</div>
		</form>
	);
}

/** Why the org isn't shown yet: still loading, or the error that stopped it. */
function OrgUnavailable({ slug, error }: { slug: string; error: string | undefined }) {
	if (!error)
		return (
			<p className="muted page__loading" role="status">
				Loading {slug}…
			</p>
		);
	return (
		<div className="box empty">
			<h2>Can't show {slug}</h2>
			<p>
				{error} <a href={href.orgs()}>Your organizations</a>.
			</p>
		</div>
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
			<main className="page" id="main">
				<OrgUnavailable slug={slug} error={org.error} />
			</main>
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
