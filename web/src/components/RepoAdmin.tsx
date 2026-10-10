import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { ManageApi, RepoAccess } from "../api";
import { canAdminister, LEVEL_WORDS, LEVELS, type Level } from "../lib/permissions";
import { isLoose } from "../lib/repoName";
import { ConfirmButton, messageOf } from "./Confirm";
import "./Manage.css";

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
	const [collaborators, setCollaborators] = useState<Collaborator[] | undefined>(undefined);
	const [listError, setListError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<{ key: string; text: string } | null>(null);
	const [handle, setHandle] = useState("");
	const [level, setLevel] = useState<Level>("write");
	const [typed, setTyped] = useState("");

	const load = () =>
		manage.collaborators(repo).then(
			(list) => {
				setCollaborators(list);
				setListError(null);
			},
			(err: unknown) => setListError(messageOf(err)),
		);
	useEffect(() => {
		if (admin && !loose) void load();
	}, [admin, loose, repo]);

	const run = async (key: string, work: () => Promise<unknown>) => {
		setBusy(key);
		setError(null);
		try {
			await work();
			setConfirming(null);
			return true;
		} catch (err) {
			setError({ key, text: messageOf(err) });
			return false;
		} finally {
			setBusy(null);
		}
	};
	const errorFor = (key: string) =>
		error?.key === key ? (
			<p className="error manage__note" role="alert">
				{error.text}
			</p>
		) : null;
	const runProps = { run, busy, errorFor };

	const add = async (event: FormEvent) => {
		event.preventDefault();
		if (!handle.trim()) return;
		const ok = await run("add", () => manage.setCollaborator(repo, handle.trim().toLowerCase(), level));
		if (ok) {
			setHandle("");
			await load();
		}
	};

	return (
		<section className="box" aria-labelledby="repo-access">
			<div className="box__header">
				<h2 id="repo-access">Access</h2>
			</div>
			<div className="box__body manage__form">
				<dl className="repo-settings__list">
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
			</div>

			{admin && !loose ? (
				<>
					<div className="box__header">
						<h2 id="repo-collaborators">Collaborators</h2>
					</div>
					{listError ? <p className="box__row error">{listError}</p> : null}
					{collaborators === undefined && !listError ? <p className="box__row muted">Loading…</p> : null}
					{collaborators?.length === 0 ? (
						<p className="box__row muted">No collaborators: the owner's members have what the owner gives them.</p>
					) : null}
					<ul className="manage__rows" aria-labelledby="repo-collaborators">
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
							/>
						))}
					</ul>
					<form className="box__body manage__form" onSubmit={add}>
						<div className="manage__inline">
							<label className="sr-only" htmlFor="collab-handle">
								Handle
							</label>
							<input
								id="collab-handle"
								type="text"
								value={handle}
								onChange={(event) => setHandle(event.target.value)}
								placeholder="Their handle"
								autoComplete="off"
								spellCheck={false}
							/>
							<label className="sr-only" htmlFor="collab-level">
								Permission
							</label>
							<select id="collab-level" value={level} onChange={(event) => setLevel(event.target.value as Level)}>
								<LevelOptions />
							</select>
							<button type="submit" className="accent" disabled={!handle.trim() || busy === "add"}>
								Add collaborator
							</button>
						</div>
						<p className="manage__hint">
							They need to have signed in to GitHive once. Their agents act with the same permission.
						</p>
						{errorFor("add")}
					</form>
				</>
			) : null}

			{admin ? (
				<DeleteRepository
					{...runProps}
					repo={repo}
					typed={typed}
					setTyped={setTyped}
					deleteRepo={() => manage.deleteRepo(repo)}
					onDeleted={onDeleted}
				/>
			) : null}
		</section>
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
		<div className="manage__inline">
			<span className="manage__label">Make it</span>
			<button type="button" className="manage__small" disabled={busy === "visibility"} onClick={toggle}>
				{visibility === "public" ? "Private" : "Public"}
			</button>
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
}: CollaboratorRowProps) {
	const { handle } = collaborator;
	const key = `collab:${handle}`;
	const runThenReload = (work: () => Promise<unknown>) => run(key, work).then((ok) => (ok ? reload() : undefined));
	return (
		<li className="box__row">
			<div className="manage__row">
				<strong className="manage__row-main">{handle}</strong>
				<div className="manage__row-actions">
					<label className="sr-only" htmlFor={`collab-${handle}`}>
						{handle}'s permission
					</label>
					<select
						id={`collab-${handle}`}
						value={collaborator.permission}
						disabled={busy === key}
						onChange={(event) => runThenReload(() => manage.setCollaborator(repo, handle, event.target.value as Level))}
					>
						<LevelOptions />
					</select>
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
	/** What's typed to confirm, which must be the repo's name. */
	typed: string;
	setTyped: (typed: string) => void;
	deleteRepo: () => Promise<unknown>;
	onDeleted: () => void;
}

function DeleteRepository({
	repo,
	typed,
	setTyped,
	deleteRepo,
	onDeleted,
	run,
	busy,
	errorFor,
}: DeleteRepositoryProps) {
	const remove = () => run("delete", deleteRepo).then((ok) => ok && onDeleted());
	return (
		<div className="box__body manage__form manage__danger">
			<h2>Delete this repository</h2>
			<p className="manage__note">
				This deletes its code, its history, GitHive's record of its claims, votes and merges, and its agents' forks. It
				can't be undone. The saved setup its containers start from is never used again and is gone within 30 days. Type{" "}
				<code>{repo}</code> to confirm.
			</p>
			<div className="manage__inline">
				<label className="sr-only" htmlFor="delete-confirm">
					Type {repo} to confirm
				</label>
				<input
					id="delete-confirm"
					type="text"
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					placeholder={repo}
					autoComplete="off"
					spellCheck={false}
				/>
				<button type="button" className="danger" disabled={typed !== repo || busy === "delete"} onClick={remove}>
					{busy === "delete" ? "Deleting…" : "Delete repository"}
				</button>
			</div>
			{errorFor("delete")}
		</div>
	);
}
