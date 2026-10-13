import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { ManageApi, MyAgent, RepoAccess } from "../api";
import { canAdminister, LEVEL_WORDS, LEVELS, type Level } from "../lib/permissions";
import { isLoose } from "../lib/repoName";
import { messageOf } from "../lib/errors";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useRowActions } from "../hooks/useRowActions";
import { useSavedNote } from "../hooks/useSavedNote";
import { useStagger } from "../hooks/useStagger";
import { type Undo, useUndo } from "../hooks/useUndo";
import { cn } from "../lib/utils";
import { ConfirmButton } from "./Confirm";
import { SettingsPart, SettingsSubhead } from "./SettingsParts";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Box, BoxBody, BoxHeader, BoxTitle } from "./ui/box";
import { Button } from "./ui/button";
import { Field, FieldHint, Input, Label, NativeSelect } from "./ui/field";
import {
	ADD_FORM,
	INLINE,
	INLINE_FIELDS,
	INLINE_INPUT,
	LINE,
	ROW,
	ROW_ACTIONS,
	ROWS,
	RULED,
	SAVED_NOTE,
	TERMS,
} from "./ui/manage";
import { UndoLine } from "./ui/undo-line";

/** What the repo's Settings can change. */
export type RepoManageApi = Pick<
	ManageApi,
	"setVisibility" | "deleteRepo" | "collaborators" | "setCollaborator" | "removeCollaborator"
> &
	Partial<Pick<ManageApi, "startRepo" | "changeSettings" | "org">> & {
		/** The reader's agents, offered as who may vote as a role (stand-ins may leave it out). */
		agents?: () => Promise<MyAgent[]>;
	};

type Collaborator = { handle: string; permission: Level };

/** How a part of the form runs an action, and shows that it's busy or what went wrong. */
interface RunProps {
	run: (key: string, work: () => Promise<unknown>) => Promise<boolean>;
	busy: string | null;
	errorFor: (key: string) => ReactNode;
}

const label = (level: Level) => level.charAt(0).toUpperCase() + level.slice(1);

function LevelOptions() {
	return (
		<>
			{LEVELS.map((level) => (
				<option key={level} value={level}>
					{label(level)}
				</option>
			))}
		</>
	);
}

function visibleTo(visibility: RepoAccess["visibility"] | undefined, loose: boolean) {
	if (visibility === "public") return "Anyone signed in to GitHive can read it";
	if (visibility === "private") return "Only the owner's members and its collaborators";
	if (loose) return "GitHive's admins: it isn't in an organization yet";
	return "Loading…";
}

/** The reader's own permission and who can see the repo; `children` (changing it) after the latter. */
function AccessTerms({
	access,
	loose,
	children,
}: {
	access: RepoAccess | undefined;
	loose: boolean;
	children?: ReactNode;
}) {
	return (
		<dl className={TERMS}>
			<dt>You</dt>
			<dd>{access ? LEVEL_WORDS[access.level] : "Loading…"}</dd>
			<dt>Visible to</dt>
			<dd>
				{visibleTo(access?.visibility, loose)}
				{children}
			</dd>
		</dl>
	);
}

/** Who may do what, for those who can't change it: their own permission, and who can see the repo. */
export function RepoAccessBox({ repo, access }: { repo: string; access: RepoAccess | undefined }) {
	return (
		<Box aria-labelledby="repo-access">
			<BoxHeader>
				<BoxTitle id="repo-access">Access</BoxTitle>
			</BoxHeader>
			<BoxBody>
				<AccessTerms access={access} loose={isLoose(repo)} />
			</BoxBody>
		</Box>
	);
}

/**
 * General & access, for the repo's admins: their permission and the repo's visibility, its collaborators, and (once
 * GitHive has started on it) how its records are kept. Visibility and collaborators apply at once.
 */
export function GeneralSection({
	repo,
	access,
	manage,
	onChanged,
	records,
}: {
	repo: string;
	access: RepoAccess | undefined;
	manage: RepoManageApi;
	onChanged: () => void;
	/** How the records are kept, folded under the rest. */
	records?: ReactNode;
}) {
	const admin = canAdminister(access?.level);
	const loose = isLoose(repo);
	const { run, busy, confirming, setConfirming, errorFor } = useRowActions();
	const runProps = { run, busy, errorFor };
	const changes = admin && !loose;

	return (
		<SettingsPart
			id="settings-general"
			title="General & access"
			description={
				changes
					? "Who can see this repo and what each person may do in it. A change to its visibility or to a collaborator applies at once."
					: "Who can see this repo and what each person may do in it."
			}
		>
			<div className="grid gap-3 px-0.5 py-4">
				<AccessTerms access={access} loose={loose}>
					{changes && access?.visibility ? (
						<VisibilityToggle
							{...runProps}
							repo={repo}
							visibility={access.visibility}
							manage={manage}
							onChanged={onChanged}
							confirming={confirming}
							setConfirming={setConfirming}
						/>
					) : null}
				</AccessTerms>
			</div>
			{changes ? (
				<CollaboratorsSection
					{...runProps}
					repo={repo}
					manage={manage}
					confirming={confirming}
					setConfirming={setConfirming}
				/>
			) : null}
			{records}
		</SettingsPart>
	);
}

interface CollaboratorsSectionProps extends RunProps {
	repo: string;
	manage: RepoManageApi;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
}

/** The repo's collaborators, each with their permission, then a form to add one. */
function CollaboratorsSection({ repo, manage, confirming, setConfirming, ...runProps }: CollaboratorsSectionProps) {
	const { run, busy, errorFor } = runProps;
	const [collaborators, setCollaborators] = useState<Collaborator[] | undefined>(undefined);
	const [listError, setListError] = useState<string | null>(null);
	const [handle, setHandle] = useState("");
	const [level, setLevel] = useState<Level>("write");
	const undo = useUndo();
	const { saved, note } = useSavedNote();
	const load = () =>
		manage.collaborators(repo).then(
			(list) => {
				setCollaborators(list);
				setListError(null);
			},
			(err: unknown) => setListError(messageOf(err)),
		);
	useEffect(() => {
		void load();
	}, [repo]);

	const add = async (event: FormEvent) => {
		event.preventDefault();
		if (!handle.trim()) return;
		const ok = await run("add", () => manage.setCollaborator(repo, handle.trim().toLowerCase(), level));
		if (ok) {
			setHandle("");
			await load();
		}
	};

	// What's read fades in as it takes the place of "Loading…", and a collaborator added later on its own.
	const arrived = useArrivals((collaborators ?? []).map((collaborator) => collaborator.handle));
	const staggers = useStagger(!!collaborators?.length);
	const read = useChanged(collaborators === undefined && !listError);
	const line = cn(LINE, "my-0", read && "animate-fade");

	return (
		<>
			<SettingsSubhead id="repo-collaborators">Collaborators</SettingsSubhead>
			{listError ? <p className={cn(line, "text-bad")}>{listError}</p> : null}
			{collaborators === undefined && !listError ? <p className={cn(line, "text-muted-foreground")}>Loading…</p> : null}
			{collaborators?.length === 0 ? (
				<p className={cn(line, "text-muted-foreground")}>
					No collaborators: the owner's members have what the owner gives them.
				</p>
			) : null}
			<ul className={cn(ROWS, staggers && "stagger")} aria-labelledby="repo-collaborators">
				{(collaborators ?? []).map((collaborator) => (
					<CollaboratorRow
						key={collaborator.handle}
						{...runProps}
						repo={repo}
						collaborator={collaborator}
						manage={manage}
						reload={load}
						confirming={confirming}
						setConfirming={setConfirming}
						arrived={arrived(collaborator.handle)}
						undo={undo}
						saved={saved === collaborator.handle}
						onSaved={() => note(collaborator.handle)}
					/>
				))}
			</ul>
			<UndoLine undo={undo} where="collaborators" className="[&>p]:mb-3" />
			<form className={ADD_FORM} onSubmit={add} aria-label="Add a collaborator">
				<div className={INLINE_FIELDS}>
					<Field className={INLINE_INPUT}>
						<Label htmlFor="collab-handle">Their handle</Label>
						<Input
							id="collab-handle"
							type="text"
							value={handle}
							onChange={(event) => setHandle(event.target.value)}
							autoComplete="off"
							spellCheck={false}
							aria-describedby="collab-handle-hint"
						/>
					</Field>
					<Field>
						<Label htmlFor="collab-level">Permission</Label>
						<NativeSelect
							id="collab-level"
							value={level}
							onChange={(event) => setLevel(event.target.value as Level)}
							aria-describedby="collab-level-hint"
						>
							<LevelOptions />
						</NativeSelect>
					</Field>
					<Button type="submit" variant="primary" disabled={!handle.trim() || busy === "add"}>
						{busy === "add" ? "Adding…" : "Add collaborator"}
					</Button>
				</div>
				<FieldHint id="collab-level-hint">{LEVEL_WORDS[level]}.</FieldHint>
				<FieldHint id="collab-handle-hint">
					They need to have signed in to GitHive once. Their agents act with the same permission.
				</FieldHint>
				{errorFor("add")}
			</form>
		</>
	);
}

interface VisibilityToggleProps extends RunProps {
	repo: string;
	visibility: "private" | "public";
	manage: RepoManageApi;
	onChanged: () => void;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
}

/** Making a repo public opens its code to everyone signed in, so it asks first; making it private doesn't. */
export function VisibilityToggle({
	repo,
	visibility,
	manage,
	onChanged,
	confirming,
	setConfirming,
	run,
	busy,
	errorFor,
}: VisibilityToggleProps) {
	const make = (next: "private" | "public") =>
		run("visibility", () => manage.setVisibility(repo, next)).then((ok) => ok && onChanged());
	return (
		<div className={INLINE}>
			{visibility === "private" ? (
				<ConfirmButton
					id="visibility"
					confirming={confirming}
					setConfirming={setConfirming}
					label="Make public"
					question={`Make ${repo} public? Anyone signed in to GitHive can read its code and history.`}
					keep="Keep private"
					busy={busy === "visibility"}
					onConfirm={() => make("public")}
				/>
			) : (
				<Button size="sm" disabled={busy === "visibility"} onClick={() => make("private")}>
					Make private
				</Button>
			)}
			{errorFor("visibility")}
		</div>
	);
}

interface CollaboratorRowProps extends RunProps {
	repo: string;
	collaborator: Collaborator;
	manage: RepoManageApi;
	/** Fetch the collaborators again, after a change. */
	reload: () => Promise<void>;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	/** Added since the list was first read: it fades in. */
	arrived: boolean;
	undo: Undo;
	/** Their permission was just changed: "Saved" shows by it. */
	saved: boolean;
	onSaved(): void;
}

/** A collaborator: their permission, what it lets them do, and removing them (with Undo). */
function CollaboratorRow({
	repo,
	collaborator,
	manage,
	reload,
	confirming,
	setConfirming,
	run,
	busy,
	errorFor,
	arrived,
	undo,
	saved,
	onSaved,
}: CollaboratorRowProps) {
	const { handle, permission } = collaborator;
	const key = `collab:${handle}`;
	const setPermission = (next: Level) =>
		run(key, () => manage.setCollaborator(repo, handle, next)).then(async (ok) => {
			if (!ok) return;
			await reload();
			onSaved();
		});
	const remove = () =>
		run(key, () => manage.removeCollaborator(repo, handle)).then(async (ok) => {
			if (!ok) return;
			await reload();
			undo.offer(
				"collaborators",
				{ done: `Removed ${handle}.`, undone: `${handle} is back, with ${label(permission)}.` },
				async () => {
					await manage.setCollaborator(repo, handle, permission);
					await reload();
				},
			);
		});
	return (
		<li className={cn(RULED, arrived && "animate-appear")}>
			<div className={ROW}>
				<div className="grid min-w-0 gap-0.5 wrap-anywhere">
					<strong>{handle}</strong>
					<span id={`collab-${handle}-means`} className="text-ui text-muted-foreground">
						{LEVEL_WORDS[permission]}
					</span>
				</div>
				<div className={ROW_ACTIONS}>
					<label className="sr-only" htmlFor={`collab-${handle}`}>
						{handle}'s permission
					</label>
					<NativeSelect
						id={`collab-${handle}`}
						value={permission}
						disabled={busy === key}
						aria-describedby={`collab-${handle}-means`}
						onChange={(event) => void setPermission(event.target.value as Level)}
					>
						<LevelOptions />
					</NativeSelect>
					<span className={SAVED_NOTE} role="status">
						{saved ? "Saved" : ""}
					</span>
					<ConfirmButton
						id={key}
						confirming={confirming}
						setConfirming={setConfirming}
						label="Remove"
						question={`Remove ${handle}? They and their agents lose ${label(permission)} access to ${repo}.`}
						keep={`Keep ${handle}`}
						busy={busy === key}
						onConfirm={remove}
					/>
				</div>
			</div>
			{errorFor(key)}
		</li>
	);
}

/** The Danger zone: deleting the repo, asked in a dialog that wants its name typed. */
export function DangerZone({
	repo,
	deleteRepo,
	onDeleted,
}: {
	repo: string;
	deleteRepo: () => Promise<unknown>;
	onDeleted: () => void;
}) {
	return (
		<SettingsPart id="settings-danger-zone" title="Danger zone" description="What can't be undone. Each asks first.">
			<div className="grid gap-3 px-0.5 py-4">
				<h3 className="text-body font-semibold">Delete this repository</h3>
				<p className="m-0 max-w-measure text-muted-foreground">
					This deletes its code, its history, GitHive's record of its claims, votes and merges, and its agents' forks.
					It can't be undone. The saved setup its containers start from is never used again and is gone within 30 days.
				</p>
				<div>
					<DeleteRepository repo={repo} deleteRepo={deleteRepo} onDeleted={onDeleted} />
				</div>
			</div>
		</SettingsPart>
	);
}

/** Deleting the repo: a dialog that names it, wants its name typed, and stays open, saying why, if deleting fails. */
function DeleteRepository({
	repo,
	deleteRepo,
	onDeleted,
}: {
	repo: string;
	deleteRepo: () => Promise<unknown>;
	onDeleted: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const field = useRef<HTMLInputElement>(null);
	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await deleteRepo();
			setOpen(false);
			onDeleted();
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (busy) return;
				setOpen(next);
				setTyped("");
				setError(null);
			}}
		>
			<AlertDialogTrigger asChild>
				<Button variant="danger">Delete repository…</Button>
			</AlertDialogTrigger>
			<AlertDialogContent
				onOpenAutoFocus={(event) => {
					// Typing its name is the question's answer, so the field takes focus.
					event.preventDefault();
					field.current?.focus();
				}}
			>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (typed === repo && !busy) void remove();
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete {repo}?</AlertDialogTitle>
						<AlertDialogDescription>
							Its code, its history, GitHive's record of its claims, votes and merges, and its agents' forks go for
							good.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<Field>
						<Label htmlFor="delete-confirm">
							Type <code>{repo}</code> to confirm
						</Label>
						<Input
							ref={field}
							id="delete-confirm"
							type="text"
							className="font-mono text-meta"
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					{error ? (
						<p className="m-0 animate-appear text-ui text-bad" role="alert">
							{error}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>Keep repository</AlertDialogCancel>
						<Button type="submit" variant="danger" disabled={typed !== repo || busy}>
							{busy ? "Deleting…" : "Delete repository"}
						</Button>
					</AlertDialogFooter>
				</form>
			</AlertDialogContent>
		</AlertDialog>
	);
}
