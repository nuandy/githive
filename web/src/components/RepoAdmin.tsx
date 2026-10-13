import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { ManageApi, RepoAccess } from "../api";
import { canAdminister, LEVEL_WORDS, LEVELS, type Level } from "../lib/permissions";
import { isLoose } from "../lib/repoName";
import { messageOf } from "../lib/errors";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useRowActions } from "../hooks/useRowActions";
import { useStagger } from "../hooks/useStagger";
import { cn } from "../lib/utils";
import { ConfirmButton } from "./Confirm";
import { Box, BoxBody, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { Input, NativeSelect } from "./ui/field";
import { INLINE, INLINE_INPUT, LINE, NOTE, ROW, ROW_ACTIONS, ROW_MAIN, ROWS, RULED, STACK, TERMS } from "./ui/manage";

/** What the repo's Settings can change. */
export type RepoManageApi = Pick<
	ManageApi,
	"setVisibility" | "deleteRepo" | "collaborators" | "setCollaborator" | "removeCollaborator"
> &
	Partial<Pick<ManageApi, "startRepo" | "changeSettings">>;

type Collaborator = { handle: string; permission: Level };

/** How a part of the form runs an action, and shows that it's busy or what went wrong. */
interface RunProps {
	run: (key: string, work: () => Promise<unknown>) => Promise<boolean>;
	busy: string | null;
	errorFor: (key: string) => ReactNode;
}

const label = (level: Level) => level.charAt(0).toUpperCase() + level.slice(1);

// On a page of its own (a repo GitHive hasn't started on), its headings are the browser's own size; in the Settings tab,
// the tab sets them smaller (SettingsTab).
const TITLE = "text-[1.5em] font-bold";

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

/**
 * Who may do what in a repo: the caller's own permission and the repo's
 * visibility; to its admins, changing visibility, collaborators, and deleting
 * it (typing its name to confirm).
 */
export function RepoAdmin({
	repo,
	access,
	manage,
	onDeleted,
	onChanged,
}: {
	repo: string;
	access: RepoAccess | undefined;
	manage: RepoManageApi;
	onDeleted: () => void;
	onChanged: () => void;
}) {
	const admin = canAdminister(access?.level);
	const loose = isLoose(repo);
	const { run, busy, confirming, setConfirming, errorFor } = useRowActions();

	const runProps = { run, busy, errorFor };

	return (
		<Box aria-labelledby="repo-access">
			<BoxHeader>
				<h2 id="repo-access" className={TITLE}>
					Access
				</h2>
			</BoxHeader>
			<BoxBody className={STACK}>
				<dl className={TERMS}>
					<dt>You</dt>
					<dd>{access ? LEVEL_WORDS[access.level] : "Loading…"}</dd>
					<dt>Visible to</dt>
					<dd>{visibleTo(access?.visibility, loose)}</dd>
				</dl>
				{admin && !loose && access?.visibility ? (
					<VisibilityToggle
						{...runProps}
						repo={repo}
						visibility={access.visibility}
						manage={manage}
						onChanged={onChanged}
					/>
				) : null}
			</BoxBody>

			{admin && !loose ? (
				<CollaboratorsSection
					{...runProps}
					repo={repo}
					manage={manage}
					confirming={confirming}
					setConfirming={setConfirming}
				/>
			) : null}

			{admin ? (
				<DeleteRepository {...runProps} repo={repo} deleteRepo={() => manage.deleteRepo(repo)} onDeleted={onDeleted} />
			) : null}
		</Box>
	);
}

interface CollaboratorsSectionProps extends RunProps {
	repo: string;
	manage: RepoManageApi;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
}

/** The repo's collaborators, each with their permission, and a form to add one. */
function CollaboratorsSection({ repo, manage, confirming, setConfirming, ...runProps }: CollaboratorsSectionProps) {
	const { run, busy, errorFor } = runProps;
	const [collaborators, setCollaborators] = useState<Collaborator[] | undefined>(undefined);
	const [listError, setListError] = useState<string | null>(null);
	const [handle, setHandle] = useState("");
	const [level, setLevel] = useState<Level>("write");
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
	const line = cn(LINE, read && "animate-fade");

	return (
		<>
			<BoxHeader>
				<h2 id="repo-collaborators" className={TITLE}>
					Collaborators
				</h2>
			</BoxHeader>
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
					/>
				))}
			</ul>
			<form className={cn("px-0.5 py-4", STACK)} onSubmit={add}>
				<div className={INLINE}>
					<label className="sr-only" htmlFor="collab-handle">
						Handle
					</label>
					<Input
						id="collab-handle"
						type="text"
						className={INLINE_INPUT}
						value={handle}
						onChange={(event) => setHandle(event.target.value)}
						placeholder="Their handle"
						autoComplete="off"
						spellCheck={false}
					/>
					<label className="sr-only" htmlFor="collab-level">
						Permission
					</label>
					<NativeSelect id="collab-level" value={level} onChange={(event) => setLevel(event.target.value as Level)}>
						<LevelOptions />
					</NativeSelect>
					<Button type="submit" variant="primary" disabled={!handle.trim() || busy === "add"}>
						Add collaborator
					</Button>
				</div>
				<p className="m-0 text-ui text-muted-foreground">
					They need to have signed in to GitHive once. Their agents act with the same permission.
				</p>
				{errorFor("add")}
			</form>
		</>
	);
}

function visibleTo(visibility: RepoAccess["visibility"] | undefined, loose: boolean) {
	if (visibility === "public") return "Anyone signed in to GitHive can read it";
	if (visibility === "private") return "Only the owner's members and its collaborators";
	if (loose) return "GitHive's admins: it isn't in an organization yet";
	return "Loading…";
}

interface VisibilityToggleProps extends RunProps {
	repo: string;
	visibility: "private" | "public";
	manage: RepoManageApi;
	onChanged: () => void;
}

function VisibilityToggle({ repo, visibility, manage, onChanged, run, busy, errorFor }: VisibilityToggleProps) {
	const toggle = () => {
		const next = visibility === "public" ? "private" : "public";
		return run("visibility", () => manage.setVisibility(repo, next)).then((ok) => ok && onChanged());
	};
	return (
		<div className={INLINE}>
			<span className="text-body-sm font-semibold">Make it</span>
			<Button size="sm" disabled={busy === "visibility"} onClick={toggle}>
				{visibility === "public" ? "Private" : "Public"}
			</Button>
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
}

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
}: CollaboratorRowProps) {
	const { handle } = collaborator;
	const key = `collab:${handle}`;
	const runThenReload = (work: () => Promise<unknown>) => run(key, work).then((ok) => (ok ? reload() : undefined));
	return (
		<li className={cn(RULED, arrived && "animate-appear")}>
			<div className={ROW}>
				<strong className={ROW_MAIN}>{handle}</strong>
				<div className={ROW_ACTIONS}>
					<label className="sr-only" htmlFor={`collab-${handle}`}>
						{handle}'s permission
					</label>
					<NativeSelect
						id={`collab-${handle}`}
						value={collaborator.permission}
						disabled={busy === key}
						onChange={(event) => runThenReload(() => manage.setCollaborator(repo, handle, event.target.value as Level))}
					>
						<LevelOptions />
					</NativeSelect>
					<ConfirmButton
						id={key}
						confirming={confirming}
						setConfirming={setConfirming}
						label="Remove"
						question={`Remove ${handle}?`}
						busy={busy === key}
						onConfirm={() => runThenReload(() => manage.removeCollaborator(repo, handle))}
					/>
				</div>
			</div>
			{errorFor(key)}
		</li>
	);
}

interface DeleteRepositoryProps extends RunProps {
	repo: string;
	deleteRepo: () => Promise<unknown>;
	onDeleted: () => void;
}

function DeleteRepository({ repo, deleteRepo, onDeleted, run, busy, errorFor }: DeleteRepositoryProps) {
	const [typed, setTyped] = useState("");
	const remove = () => run("delete", deleteRepo).then((ok) => ok && onDeleted());
	return (
		<BoxBody className={STACK}>
			<h2 className={TITLE}>Delete this repository</h2>
			<p className={NOTE}>
				This deletes its code, its history, GitHive's record of its claims, votes and merges, and its agents' forks. It
				can't be undone. The saved setup its containers start from is never used again and is gone within 30 days. Type{" "}
				<code>{repo}</code> to confirm.
			</p>
			<div className={INLINE}>
				<label className="sr-only" htmlFor="delete-confirm">
					Type {repo} to confirm
				</label>
				<Input
					id="delete-confirm"
					type="text"
					className={INLINE_INPUT}
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					placeholder={repo}
					autoComplete="off"
					spellCheck={false}
				/>
				<Button variant="danger" disabled={typed !== repo || busy === "delete"} onClick={remove}>
					{busy === "delete" ? "Deleting…" : "Delete repository"}
				</Button>
			</div>
			{errorFor("delete")}
		</BoxBody>
	);
}
