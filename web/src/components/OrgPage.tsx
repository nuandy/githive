import { type FormEvent, useState } from "react";
import type { ManageApi, OrgDetail, OrgRole } from "../api";
import { usePoll } from "../hooks/usePoll";
import { addedMessage, assignableRoles, canLeave, canManage, SLUG_HINT, slugProblem } from "../lib/orgs";
import { LEVELS, type Level } from "../lib/permissions";
import { href } from "../lib/routes";
import { ConfirmButton, messageOf } from "./Confirm";
import { Icon } from "./Icon";
import "./Manage.css";

/** What the org page can do; the page refreshes after each. */
export type OrgActions = Pick<ManageApi, "updateOrg" | "addMember" | "setRole" | "removeMember" | "cancelInvite" | "createTeam" | "deleteTeam" | "addTeamMember" | "removeTeamMember">;

export interface OrgViewProps {
	org: OrgDetail;
	me: { handle: string };
	actions: OrgActions;
	/** After leaving: the org is no longer yours to see in full. */
	onLeft: () => void;
}

const ROLE_WORDS: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

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
			(onError ?? ((text: string) => setRowError({ id: key, text })))(messageOf(err));
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

	return (
		<main className="page manage" id="main">
			<header className="manage__header">
				<div>
					<h1>{mine ? "Your repositories" : org.name || org.slug}</h1>
					<p className="muted manage__lede">
						{mine ? (
							<>
								Repositories under your name, <code>{org.slug}/&lt;name&gt;</code>. Add collaborators to one in its Settings.
							</>
						) : org.personal ? (
							<>{org.slug}'s repositories that you can see.</>
						) : (
							<>
								<code>{org.slug}</code>
								{org.role ? ` · you're ${org.role === "admin" ? "an admin" : `a${org.role === "owner" ? "n owner" : " member"}`}` : ""}
							</>
						)}
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
							confirming={confirming}
							setConfirming={setConfirming}
							label="Leave"
							question={`Leave ${org.slug}?`}
							busy={busy === "leave"}
							onConfirm={() => run("leave", () => actions.removeMember(org.slug, me.handle)).then((ok) => ok && onLeft())}
						/>
					) : null}
				</div>
			</header>
			{errorFor("leave")}

			<section className="box" aria-labelledby="org-repos">
				<div className="box__header">
					<h2 id="org-repos">Repositories</h2>
				</div>
				{org.repos.length === 0 ? (
					<p className="box__row muted">{org.canCreateRepos ? "None yet." : "None that you can see."}</p>
				) : (
					<ul className="manage__rows">
						{org.repos.map((repo) => (
							<li key={repo.id} className="box__row manage__row">
								<div className="manage__row-main">
									<Icon name="repo" className="muted" />
									<a href={href.repo(repo.fullName)}>{repo.fullName}</a>
								</div>
								<span className={`pill ${repo.visibility === "public" ? "pill--accent" : "pill--neutral"}`}>{repo.visibility === "public" ? "Public" : "Private"}</span>
							</li>
						))}
					</ul>
				)}
			</section>

			{!org.personal && org.role ? (
				<>
					<MembersSection org={org} me={me} manager={manager} actions={actions} run={run} busy={busy} confirming={confirming} setConfirming={setConfirming} errorFor={errorFor} />
					<TeamsSection org={org} manager={manager} actions={actions} run={run} busy={busy} confirming={confirming} setConfirming={setConfirming} errorFor={errorFor} />
					{manager ? <SettingsSection org={org} actions={actions} run={run} busy={busy} errorFor={errorFor} /> : null}
				</>
			) : null}
		</main>
	);
}

interface SectionProps {
	org: OrgDetail;
	actions: OrgActions;
	run: (key: string, work: () => Promise<unknown>, onError?: (text: string) => void) => Promise<boolean>;
	busy: string | null;
	errorFor: (key: string) => React.ReactNode;
}
type ConfirmProps = { confirming: string | null; setConfirming: (id: string | null) => void };

function Avatar({ person }: { person: { handle: string; name: string | null; avatarUrl: string | null } }) {
	return person.avatarUrl ? (
		<img className="manage__avatar" src={person.avatarUrl} alt="" width={22} height={22} referrerPolicy="no-referrer" />
	) : (
		<span className="manage__avatar manage__avatar--initial" aria-hidden="true">
			{(person.name || person.handle).charAt(0).toUpperCase()}
		</span>
	);
}

function MembersSection({ org, me, manager, actions, run, busy, confirming, setConfirming, errorFor }: SectionProps & ConfirmProps & { me: { handle: string }; manager: boolean }) {
	const roles = assignableRoles(org.role);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<OrgRole>("member");
	const [added, setAdded] = useState<string | null>(null);
	const [addError, setAddError] = useState<string | null>(null);

	const add = async (event: FormEvent) => {
		event.preventDefault();
		if (!email.trim()) return;
		setAdded(null);
		setAddError(null);
		let result: { added?: string; invited?: string; awaitingApproval?: boolean } = {};
		const ok = await run("add-member", async () => (result = await actions.addMember(org.slug, email.trim(), role)), setAddError);
		if (ok) {
			setAdded(addedMessage(result));
			setEmail("");
		}
	};

	return (
		<section className="box" aria-labelledby="org-members">
			<div className="box__header">
				<h2 id="org-members">People</h2>
			</div>
			<ul className="manage__rows">
				{org.members.map((m) => {
					// Only an owner changes or removes an owner.
					const editable = manager && (m.role !== "owner" || org.role === "owner") && m.handle !== me.handle;
					const key = `member:${m.handle}`;
					return (
						<li key={m.userId} className="box__row">
							<div className="manage__row">
								<div className="manage__row-main">
									<Avatar person={m} />
									<strong>{m.handle}</strong>
									{m.name ? <span className="muted">{m.name}</span> : null}
									{m.handle === me.handle ? <span className="muted">(you)</span> : null}
								</div>
								<div className="manage__row-actions">
									{editable ? (
										<>
											<label className="sr-only" htmlFor={`role-${m.handle}`}>
												{m.handle}'s role
											</label>
											<select id={`role-${m.handle}`} value={m.role} disabled={busy === key} onChange={(e) => run(key, () => actions.setRole(org.slug, m.handle, e.target.value as OrgRole))}>
												{[...new Set([...roles, m.role])].map((r) => (
													<option key={r} value={r}>
														{ROLE_WORDS[r]}
													</option>
												))}
											</select>
											<ConfirmButton
												id={`remove:${m.handle}`}
												confirming={confirming}
												setConfirming={setConfirming}
												label="Remove"
												question={`Remove ${m.handle} from ${org.slug}?`}
												busy={busy === key}
												onConfirm={() => run(key, () => actions.removeMember(org.slug, m.handle))}
											/>
										</>
									) : (
										<span className="pill pill--neutral">{ROLE_WORDS[m.role]}</span>
									)}
								</div>
							</div>
							{errorFor(key)}
						</li>
					);
				})}
				{manager
					? org.invites.map((invite) => {
							const key = `invite:${invite.email}`;
							return (
								<li key={invite.email} className="box__row">
									<div className="manage__row">
										<div className="manage__row-main">
											<Icon name="clock" className="muted" />
											<span>{invite.email}</span>
											<span className="muted">invited as {invite.role}; joins when they first sign in</span>
										</div>
										<ConfirmButton
											id={key}
											confirming={confirming}
											setConfirming={setConfirming}
											label="Cancel invitation"
											question={`Cancel ${invite.email}'s invitation?`}
											busy={busy === key}
											onConfirm={() => run(key, () => actions.cancelInvite(org.slug, invite.email))}
										/>
									</div>
									{errorFor(key)}
								</li>
							);
						})
					: null}
			</ul>
			{manager ? (
				<form className="box__body manage__form" onSubmit={add}>
					<div className="manage__inline">
						<label className="sr-only" htmlFor="add-member-email">
							Email address
						</label>
						<input id="add-member-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" autoComplete="off" />
						<label className="sr-only" htmlFor="add-member-role">
							Role
						</label>
						<select id="add-member-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
							{roles.map((r) => (
								<option key={r} value={r}>
									{ROLE_WORDS[r]}
								</option>
							))}
						</select>
						<button type="submit" className="accent" disabled={!email.trim() || busy === "add-member"}>
							{busy === "add-member" ? "Adding…" : "Add"}
						</button>
					</div>
					<p className="manage__hint">Someone who hasn't signed in yet is invited, and joins when they first sign in to GitHive, once a GitHive admin has approved them.</p>
					{added ? (
						<p className="manage__note" role="status">
							{added}
						</p>
					) : null}
					{addError ? (
						<p className="error manage__note" role="alert">
							{addError}
						</p>
					) : null}
				</form>
			) : null}
		</section>
	);
}

function TeamsSection({ org, manager, actions, run, busy, confirming, setConfirming, errorFor }: SectionProps & ConfirmProps & { manager: boolean }) {
	const [slug, setSlug] = useState("");
	const [name, setName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [adding, setAdding] = useState<Record<string, string>>({});
	const problem = slug ? slugProblem(slug) : null;

	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (!slug || problem) return;
		setCreateError(null);
		if (await run("create-team", () => actions.createTeam(org.slug, slug, name.trim()), setCreateError)) {
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
				A team can be granted a role when GitHive is started on a repo, like <code>{`security = @${org.slug}/security`}</code>: anyone on the team when they vote counts as that role.
			</p>
			{org.teams.length === 0 ? <p className="box__row muted">No teams yet.</p> : null}
			<ul className="manage__rows">
				{org.teams.map((team) => {
					const key = `team:${team.slug}`;
					const others = org.members.map((m) => m.handle).filter((h) => !team.members.includes(h));
					return (
						<li key={team.id} className="box__row manage__team">
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
											<button type="button" aria-label={`Take ${handle} off @${org.slug}/${team.slug}`} disabled={busy === key} onClick={() => run(key, () => actions.removeTeamMember(org.slug, team.slug, handle))}>
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
									<select id={`team-add-${team.slug}`} value={adding[team.slug] ?? ""} onChange={(e) => setAdding({ ...adding, [team.slug]: e.target.value })}>
										<option value="">Add a member…</option>
										{others.map((h) => (
											<option key={h} value={h}>
												{h}
											</option>
										))}
									</select>
									<button
										type="button"
										className="manage__small"
										disabled={!adding[team.slug] || busy === key}
										onClick={() => run(key, () => actions.addTeamMember(org.slug, team.slug, adding[team.slug]!)).then((ok) => ok && setAdding({ ...adding, [team.slug]: "" }))}
									>
										Add
									</button>
								</div>
							) : null}
							{errorFor(key)}
						</li>
					);
				})}
			</ul>
			{manager ? (
				<form className="box__body manage__form" onSubmit={create}>
					<div className="manage__inline">
						<label className="sr-only" htmlFor="new-team-slug">
							Team name
						</label>
						<input id="new-team-slug" type="text" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="security" autoComplete="off" spellCheck={false} />
						<label className="sr-only" htmlFor="new-team-name">
							Display name
						</label>
						<input id="new-team-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (optional)" autoComplete="off" />
						<button type="submit" className="accent" disabled={!slug || !!problem || busy === "create-team"}>
							New team
						</button>
					</div>
					<p className="manage__hint">{problem ? <span className="error">{problem}</span> : slug ? `Granted as @${org.slug}/${slug}.` : SLUG_HINT}</p>
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

function SettingsSection({ org, actions, run, busy, errorFor }: SectionProps) {
	const [name, setName] = useState(org.name ?? "");
	const [level, setLevel] = useState<Level>(org.defaultPermission);
	const [create, setCreate] = useState(org.membersCanCreateRepos);
	const [saved, setSaved] = useState(false);
	const changed = name !== (org.name ?? "") || level !== org.defaultPermission || create !== org.membersCanCreateRepos;

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setSaved(false);
		if (await run("settings", () => actions.updateOrg(org.slug, { name: name.trim() || null, default_permission: level, members_can_create_repos: create }))) setSaved(true);
	};

	return (
		<form className="box" onSubmit={save} aria-labelledby="org-settings">
			<div className="box__header">
				<h2 id="org-settings">Settings</h2>
			</div>
			<div className="box__body manage__form">
				<div className="manage__field">
					<label htmlFor="org-name">Display name</label>
					<input id="org-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={org.slug} autoComplete="off" />
				</div>
				<div className="manage__field">
					<label htmlFor="org-default">What members can do in its repositories</label>
					<select id="org-default" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
						{LEVELS.map((l) => (
							<option key={l} value={l}>
								{l[0].toUpperCase() + l.slice(1)}
							</option>
						))}
					</select>
					<p className="manage__hint">Owners and admins can always do everything. Collaborators added to one repository get what they're given there.</p>
				</div>
				<label className="manage__choice">
					<input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
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

/** The page, with its data. */
export function OrgPage({ slug, me, manage }: { slug: string; me: { handle: string }; manage: ManageApi }) {
	const org = usePoll(`org:${slug}`, () => manage.org(slug), 60_000);
	const after =
		<A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			const result = await work(...args);
			org.refresh();
			return result;
		};
	const actions: OrgActions = {
		updateOrg: after(manage.updateOrg),
		addMember: after(manage.addMember),
		setRole: after(manage.setRole),
		removeMember: after(manage.removeMember),
		cancelInvite: after(manage.cancelInvite),
		createTeam: after(manage.createTeam),
		deleteTeam: after(manage.deleteTeam),
		addTeamMember: after(manage.addTeamMember),
		removeTeamMember: after(manage.removeTeamMember),
	};
	if (!org.data)
		return (
			<main className="page" id="main">
				{org.error ? (
					<div className="box empty">
						<h2>Can't show {slug}</h2>
						<p>
							{org.error} <a href={href.orgs()}>Your organizations</a>.
						</p>
					</div>
				) : (
					<p className="muted page__loading" role="status">
						Loading {slug}…
					</p>
				)}
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
