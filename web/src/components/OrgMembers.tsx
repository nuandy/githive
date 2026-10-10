import { type FormEvent, useState } from "react";
import type { OrgDetail, OrgRole } from "../api";
import { addedMessage, assignableRoles } from "../lib/orgs";
import { ConfirmButton } from "./Confirm";
import { Icon } from "./Icon";
import type { ConfirmProps, SectionProps } from "./OrgPage";

type Member = OrgDetail["members"][number];
type Invite = OrgDetail["invites"][number];

const ROLE_WORDS: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function Avatar({ person }: { person: { handle: string; name: string | null; avatarUrl: string | null } }) {
	if (person.avatarUrl)
		return (
			<img
				className="manage__avatar"
				src={person.avatarUrl}
				alt=""
				width={22}
				height={22}
				referrerPolicy="no-referrer"
			/>
		);
	return (
		<span className="manage__avatar manage__avatar--initial" aria-hidden="true">
			{(person.name || person.handle).charAt(0).toUpperCase()}
		</span>
	);
}

/** The org's people and pending invitations; to its managers, adding, changing and removing them. */
export function MembersSection({
	org,
	me,
	manager,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	errorFor,
}: SectionProps & ConfirmProps & { me: { handle: string }; manager: boolean }) {
	const roles = assignableRoles(org.role);
	const rowProps = { org, actions, run, busy, confirming, setConfirming, errorFor };

	return (
		<section className="box" aria-labelledby="org-members">
			<div className="box__header">
				<h2 id="org-members">People</h2>
			</div>
			<ul className="manage__rows">
				{org.members.map((member) => {
					const isMe = member.handle === me.handle;
					// Only an owner changes or removes an owner.
					const editable = manager && (member.role !== "owner" || org.role === "owner") && !isMe;
					return (
						<MemberRow
							key={member.userId}
							{...rowProps}
							member={member}
							isMe={isMe}
							editable={editable}
							roles={roles}
						/>
					);
				})}
				{manager ? org.invites.map((invite) => <InviteRow key={invite.email} {...rowProps} invite={invite} />) : null}
			</ul>
			{manager ? <AddMemberForm org={org} actions={actions} run={run} busy={busy} roles={roles} /> : null}
		</section>
	);
}

/** Adds a person by email, at once if they've signed in to GitHive, or else as an invitation. */
function AddMemberForm({
	org,
	actions,
	run,
	busy,
	roles,
}: Pick<SectionProps, "org" | "actions" | "run" | "busy"> & { roles: OrgRole[] }) {
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
		const ok = await run(
			"add-member",
			async () => (result = await actions.addMember(org.slug, email.trim(), role)),
			setAddError,
		);
		if (ok) {
			setAdded(addedMessage(result));
			setEmail("");
		}
	};

	return (
		<form className="box__body manage__form" onSubmit={add}>
			<div className="manage__inline">
				<label className="sr-only" htmlFor="add-member-email">
					Email address
				</label>
				<input
					id="add-member-email"
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="person@example.com"
					autoComplete="off"
				/>
				<label className="sr-only" htmlFor="add-member-role">
					Role
				</label>
				<select id="add-member-role" value={role} onChange={(event) => setRole(event.target.value as OrgRole)}>
					{roles.map((option) => (
						<option key={option} value={option}>
							{ROLE_WORDS[option]}
						</option>
					))}
				</select>
				<button type="submit" className="accent" disabled={!email.trim() || busy === "add-member"}>
					{busy === "add-member" ? "Adding…" : "Add"}
				</button>
			</div>
			<p className="manage__hint">
				Someone who hasn't signed in yet is invited, and joins when they first sign in to GitHive, once a GitHive admin
				has approved them.
			</p>
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
	);
}

interface MemberRowProps extends SectionProps, ConfirmProps {
	member: Member;
	isMe: boolean;
	/** Whether you may change this member's role or remove them. */
	editable: boolean;
	/** The roles you may give. */
	roles: OrgRole[];
}

function MemberRow({ member, isMe, editable, roles, errorFor, ...rest }: MemberRowProps) {
	const key = `member:${member.handle}`;
	return (
		<li className="box__row">
			<div className="manage__row">
				<div className="manage__row-main">
					<Avatar person={member} />
					<strong>{member.handle}</strong>
					{member.name ? <span className="muted">{member.name}</span> : null}
					{isMe ? <span className="muted">(you)</span> : null}
				</div>
				<div className="manage__row-actions">
					{editable ? (
						<MemberControls member={member} roles={roles} rowKey={key} {...rest} />
					) : (
						<span className="pill pill--neutral">{ROLE_WORDS[member.role]}</span>
					)}
				</div>
			</div>
			{errorFor(key)}
		</li>
	);
}

type MemberControlsProps = Omit<SectionProps, "errorFor"> &
	ConfirmProps & { member: Member; roles: OrgRole[]; rowKey: string };

/** Changing a member's role, and removing them. */
function MemberControls({
	org,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	member,
	roles,
	rowKey,
}: MemberControlsProps) {
	const choices = [...new Set([...roles, member.role])];
	const changeRole = (role: OrgRole) => run(rowKey, () => actions.setRole(org.slug, member.handle, role));
	return (
		<>
			<label className="sr-only" htmlFor={`role-${member.handle}`}>
				{member.handle}'s role
			</label>
			<select
				id={`role-${member.handle}`}
				value={member.role}
				disabled={busy === rowKey}
				onChange={(event) => changeRole(event.target.value as OrgRole)}
			>
				{choices.map((choice) => (
					<option key={choice} value={choice}>
						{ROLE_WORDS[choice]}
					</option>
				))}
			</select>
			<ConfirmButton
				id={`remove:${member.handle}`}
				confirming={confirming}
				setConfirming={setConfirming}
				label="Remove"
				question={`Remove ${member.handle} from ${org.slug}?`}
				busy={busy === rowKey}
				onConfirm={() => run(rowKey, () => actions.removeMember(org.slug, member.handle))}
			/>
		</>
	);
}

function InviteRow({
	org,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	errorFor,
	invite,
}: SectionProps & ConfirmProps & { invite: Invite }) {
	const key = `invite:${invite.email}`;
	return (
		<li className="box__row">
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
}
