import { type FormEvent, useState } from "react";
import type { OrgDetail, OrgRole } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useStagger } from "../hooks/useStagger";
import { addedMessage, assignableRoles } from "../lib/orgs";
import { cn } from "../lib/utils";
import { ConfirmButton } from "./Confirm";
import { Icon } from "./Icon";
import type { ConfirmProps, SectionProps } from "./OrgPage";
import { Badge } from "./ui/badge";
import { Box, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { FieldHint, Input, NativeSelect } from "./ui/field";
import { INLINE, INLINE_INPUT, NOTE, ROW, ROW_ACTIONS, ROW_MAIN, ROWS, RULED, STACK, TITLE } from "./ui/manage";

type Member = OrgDetail["members"][number];
type Invite = OrgDetail["invites"][number];

const ROLE_WORDS: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function Avatar({ person }: { person: { handle: string; name: string | null; avatarUrl: string | null } }) {
	if (person.avatarUrl)
		return (
			<img
				className="size-5.5 flex-none rounded-full"
				src={person.avatarUrl}
				alt=""
				width={22}
				height={22}
				referrerPolicy="no-referrer"
			/>
		);
	return (
		<span
			className="inline-grid size-5.5 flex-none place-items-center rounded-full bg-link-soft text-caption font-semibold text-link"
			aria-hidden="true"
		>
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
	// Someone added or invited since the page showed fades in.
	const arrived = useArrivals([
		...org.members.map((member) => member.handle),
		...org.invites.map((invite) => `invite:${invite.email}`),
	]);
	const staggers = useStagger(org.members.length > 0);

	return (
		<Box aria-labelledby="org-members">
			<BoxHeader>
				<h2 id="org-members" className={TITLE}>
					People
				</h2>
			</BoxHeader>
			<ul className={cn(ROWS, staggers && "stagger")}>
				{org.members.map((member) => {
					const isMe = member.handle === me.handle;
					// Only an owner changes or removes an owner.
					const editable = manager && (member.role !== "owner" || org.role === "owner") && !isMe;
					return (
						<MemberRow
							key={member.userId}
							{...rowProps}
							arrived={arrived(member.handle)}
							member={member}
							isMe={isMe}
							editable={editable}
							roles={roles}
						/>
					);
				})}
				{manager
					? org.invites.map((invite) => (
							<InviteRow key={invite.email} {...rowProps} arrived={arrived(`invite:${invite.email}`)} invite={invite} />
						))
					: null}
			</ul>
			{manager ? <AddMemberForm org={org} actions={actions} run={run} busy={busy} roles={roles} /> : null}
		</Box>
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
		<form className={cn("px-0.5 py-4", STACK)} onSubmit={add}>
			<div className={INLINE}>
				<label className="sr-only" htmlFor="add-member-email">
					Email address
				</label>
				<Input
					id="add-member-email"
					type="email"
					className={INLINE_INPUT}
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="person@example.com"
					autoComplete="off"
				/>
				<label className="sr-only" htmlFor="add-member-role">
					Role
				</label>
				<NativeSelect id="add-member-role" value={role} onChange={(event) => setRole(event.target.value as OrgRole)}>
					{roles.map((option) => (
						<option key={option} value={option}>
							{ROLE_WORDS[option]}
						</option>
					))}
				</NativeSelect>
				<Button type="submit" variant="primary" disabled={!email.trim() || busy === "add-member"}>
					{busy === "add-member" ? "Adding…" : "Add"}
				</Button>
			</div>
			<FieldHint>
				Someone who hasn't signed in yet is invited, and joins when they first sign in to GitHive, once a GitHive admin
				has approved them.
			</FieldHint>
			{added ? (
				<p className={cn(NOTE, "animate-appear")} role="status">
					{added}
				</p>
			) : null}
			{addError ? (
				<p className={cn(NOTE, "animate-appear text-bad")} role="alert">
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
	/** Added since the page showed: it fades in. */
	arrived: boolean;
}

function MemberRow({ member, isMe, editable, roles, errorFor, arrived, ...rest }: MemberRowProps) {
	const key = `member:${member.handle}`;
	return (
		<li className={cn(RULED, arrived && "animate-appear")}>
			<div className={ROW}>
				<div className={ROW_MAIN}>
					<Avatar person={member} />
					<strong>{member.handle}</strong>
					{member.name ? <span className="text-muted-foreground">{member.name}</span> : null}
					{isMe ? <span className="text-muted-foreground">(you)</span> : null}
				</div>
				<div className={ROW_ACTIONS}>
					{editable ? (
						<MemberControls member={member} roles={roles} rowKey={key} {...rest} />
					) : (
						<Badge tone="neutral">{ROLE_WORDS[member.role]}</Badge>
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
			<NativeSelect
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
			</NativeSelect>
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
	arrived,
}: SectionProps & ConfirmProps & { invite: Invite; arrived: boolean }) {
	const key = `invite:${invite.email}`;
	return (
		<li className={cn(RULED, arrived && "animate-appear")}>
			<div className={ROW}>
				<div className={ROW_MAIN}>
					<Icon name="clock" className="text-muted-foreground" />
					<span>{invite.email}</span>
					<span className="text-muted-foreground">invited as {invite.role}; joins when they first sign in</span>
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
