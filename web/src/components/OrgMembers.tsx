import { type FormEvent, useRef, useState } from "react";
import type { OrgDetail, OrgRole } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useSavedNote } from "../hooks/useSavedNote";
import { useStagger } from "../hooks/useStagger";
import { addedMessage, assignableRoles } from "../lib/orgs";
import { cn } from "../lib/utils";
import { ConfirmButton, Question } from "./Confirm";
import { Icon } from "./Icon";
import type { ConfirmProps, SectionProps, UndoProps } from "./OrgPage";
import { Badge } from "./ui/badge";
import { Box, BoxHeader, BoxTitle } from "./ui/box";
import { Button } from "./ui/button";
import { Field, FieldHint, Input, Label, NativeSelect } from "./ui/field";
import { UndoLine } from "./ui/undo-line";
import {
	ADD_FORM,
	INLINE_FIELDS,
	INLINE_INPUT,
	NOTE,
	ROW,
	ROW_ACTIONS,
	ROW_MAIN,
	ROWS,
	RULED,
	SAVED_NOTE,
} from "./ui/manage";

type Member = OrgDetail["members"][number];
type Invite = OrgDetail["invites"][number];

const ROLE_WORDS: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/** What a role lets someone do in the org, in words. */
export function roleMeans(role: OrgRole, org: Pick<OrgDetail, "defaultPermission">): string {
	if (role === "owner") return "Owner: everything an admin can, and make and remove other owners";
	if (role === "admin")
		return "Admin: add and remove people and teams, change the org's settings, and administer every repository in it";
	const level = org.defaultPermission.charAt(0).toUpperCase() + org.defaultPermission.slice(1);
	return `Member: ${level} in its repositories, as its settings say, and what collaborators get`;
}

/** The question before making someone an admin or owner: what they'll be able to do. */
export function promotionQuestion(handle: string, org: string, role: OrgRole): string {
	if (role === "owner")
		return `Make ${handle} an owner of ${org}? Owners can delete any of its repositories, and remove anyone, other owners too.`;
	return `Make ${handle} an admin of ${org}? Admins can delete any of its repositories, and add and remove its people and teams.`;
}

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
	undo,
}: SectionProps & ConfirmProps & UndoProps & { me: { handle: string }; manager: boolean }) {
	const roles = assignableRoles(org.role);
	const { saved, note } = useSavedNote();
	// Invitations this page saw made that wait on GitHive's approval, for a server that doesn't say so itself.
	const [waiting, setWaiting] = useState<string[]>([]);
	const rowProps = { org, actions, run, busy, confirming, setConfirming, errorFor, undo };
	// Someone added or invited since the page showed fades in.
	const arrived = useArrivals([
		...org.members.map((member) => member.handle),
		...org.invites.map((invite) => `invite:${invite.email}`),
	]);
	const staggers = useStagger(org.members.length > 0);

	return (
		<Box aria-labelledby="org-members">
			<BoxHeader>
				<BoxTitle id="org-members">People</BoxTitle>
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
							saved={saved === member.handle}
							onSaved={() => note(member.handle)}
						/>
					);
				})}
				{manager
					? org.invites.map((invite) => (
							<InviteRow
								key={invite.email}
								{...rowProps}
								arrived={arrived(`invite:${invite.email}`)}
								invite={invite}
								waiting={!!invite.awaitingApproval || waiting.includes(invite.email)}
							/>
						))
					: null}
			</ul>
			<UndoLine undo={undo} where="members" className="[&>p]:mb-3" />
			{manager ? (
				<AddMemberForm
					org={org}
					actions={actions}
					run={run}
					busy={busy}
					roles={roles}
					onWaiting={(email) => setWaiting((emails) => [...emails, email])}
				/>
			) : null}
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
	onWaiting,
}: Pick<SectionProps, "org" | "actions" | "run" | "busy"> & {
	roles: OrgRole[];
	/** An invitation made that waits on GitHive's approval. */
	onWaiting(email: string): void;
}) {
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
			if (result.invited && result.awaitingApproval) onWaiting(result.invited);
			setEmail("");
		}
	};

	return (
		<form className={ADD_FORM} onSubmit={add} aria-label="Add a person">
			<div className={INLINE_FIELDS}>
				<Field className={INLINE_INPUT}>
					<Label htmlFor="add-member-email">Email</Label>
					<Input
						id="add-member-email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						autoComplete="off"
						aria-describedby="add-member-hint"
					/>
				</Field>
				<Field>
					<Label htmlFor="add-member-role">Role</Label>
					<NativeSelect
						id="add-member-role"
						value={role}
						onChange={(event) => setRole(event.target.value as OrgRole)}
						aria-describedby="add-member-role-hint"
					>
						{roles.map((option) => (
							<option key={option} value={option}>
								{ROLE_WORDS[option]}
							</option>
						))}
					</NativeSelect>
				</Field>
				<Button type="submit" variant="primary" disabled={!email.trim() || busy === "add-member"}>
					{busy === "add-member" ? "Adding…" : "Add"}
				</Button>
			</div>
			<FieldHint id="add-member-role-hint">{roleMeans(role, org)}.</FieldHint>
			<FieldHint id="add-member-hint">
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

interface MemberRowProps extends SectionProps, ConfirmProps, UndoProps {
	member: Member;
	isMe: boolean;
	/** Whether you may change this member's role or remove them. */
	editable: boolean;
	/** The roles you may give. */
	roles: OrgRole[];
	/** Added since the page showed: it fades in. */
	arrived: boolean;
	/** Their role was just changed: "Saved" shows by it. */
	saved: boolean;
	onSaved(): void;
}

function MemberRow({ member, isMe, editable, roles, errorFor, arrived, undo: _, ...rest }: MemberRowProps) {
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
	ConfirmProps & { member: Member; roles: OrgRole[]; rowKey: string; saved: boolean; onSaved(): void };

/**
 * Changing a member's role, and removing them. Making someone an admin or an owner asks first, in place of the
 * controls, saying what they'll be able to do; a role changed says Saved.
 */
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
	saved,
	onSaved,
}: MemberControlsProps) {
	const choices = [...new Set([...roles, member.role])];
	const [promoting, setPromoting] = useState<OrgRole | null>(null);
	const select = useRef<HTMLSelectElement>(null);
	const changeRole = (role: OrgRole) =>
		run(rowKey, () => actions.setRole(org.slug, member.handle, role)).then((ok) => {
			setPromoting(null);
			if (ok) onSaved();
		});
	const choose = (role: OrgRole) => (RANK[role] > RANK[member.role] ? setPromoting(role) : void changeRole(role));

	if (promoting)
		return (
			<Question
				question={promotionQuestion(member.handle, org.slug, promoting)}
				yes={`Yes, make ${promoting}`}
				keep={`Keep ${member.handle} ${member.role === "admin" ? "an admin" : "a member"}`}
				yesVariant="primary"
				busy={busy === rowKey}
				onYes={() => void changeRole(promoting)}
				onKeep={() => {
					setPromoting(null);
					// Focus goes back to the select, once it's back.
					requestAnimationFrame(() => select.current?.focus());
				}}
			/>
		);
	return (
		<>
			<label className="sr-only" htmlFor={`role-${member.handle}`}>
				{member.handle}'s role
			</label>
			<NativeSelect
				ref={select}
				id={`role-${member.handle}`}
				value={member.role}
				disabled={busy === rowKey}
				onChange={(event) => choose(event.target.value as OrgRole)}
			>
				{choices.map((choice) => (
					<option key={choice} value={choice}>
						{ROLE_WORDS[choice]}
					</option>
				))}
			</NativeSelect>
			<span className={SAVED_NOTE} role="status">
				{saved ? "Saved" : ""}
			</span>
			<ConfirmButton
				id={`remove:${member.handle}`}
				confirming={confirming}
				setConfirming={setConfirming}
				label="Remove"
				question={`Remove ${member.handle} from ${org.slug}? They lose what its members can do, and their teams.`}
				keep={`Keep ${member.handle}`}
				busy={busy === rowKey}
				onConfirm={() => run(rowKey, () => actions.removeMember(org.slug, member.handle))}
			/>
		</>
	);
}

/** An invitation: who, as what, when they'll join (once GitHive approves them, if it hasn't), and cancelling it. */
function InviteRow({
	org,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	errorFor,
	undo,
	invite,
	waiting,
	arrived,
}: SectionProps & ConfirmProps & UndoProps & { invite: Invite; waiting: boolean; arrived: boolean }) {
	const key = `invite:${invite.email}`;
	const cancel = () =>
		run(key, () => actions.cancelInvite(org.slug, invite.email)).then(
			(ok) =>
				ok &&
				undo.offer(
					"members",
					{ done: `Cancelled ${invite.email}'s invitation.`, undone: `${invite.email} is invited again.` },
					() => actions.addMember(org.slug, invite.email, invite.role),
				),
		);
	return (
		<li className={cn(RULED, arrived && "animate-appear")}>
			<div className={ROW}>
				<div className={ROW_MAIN}>
					<Icon name="clock" className="text-muted-foreground" />
					<span>{invite.email}</span>
					{waiting ? (
						<Badge tone="warn" size="sm">
							Waiting for GitHive approval
						</Badge>
					) : null}
					<span className="text-muted-foreground">
						invited as {invite.role};{" "}
						{waiting ? "joins once a GitHive admin approves them and they sign in" : "joins when they first sign in"}
					</span>
				</div>
				<div className={ROW_ACTIONS}>
					<ConfirmButton
						id={key}
						confirming={confirming}
						setConfirming={setConfirming}
						label="Cancel invitation"
						question={`Cancel ${invite.email}'s invitation? They won't join ${org.slug} when they sign in.`}
						keep="Keep invitation"
						busy={busy === key}
						onConfirm={cancel}
					/>
				</div>
			</div>
			{errorFor(key)}
		</li>
	);
}
