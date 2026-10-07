import { type FormEvent, useEffect, useState } from "react";
import type { ManageApi, RepoAccess } from "../api";
import { canAdminister, LEVEL_WORDS, LEVELS, type Level } from "../lib/permissions";
import { isLoose } from "../lib/repoName";
import { ConfirmButton, messageOf } from "./Confirm";
import "./Manage.css";

/** What the repo's Settings can change. */
export type RepoManageApi = Pick<ManageApi, "setVisibility" | "deleteRepo" | "collaborators" | "setCollaborator" | "removeCollaborator"> & Partial<Pick<ManageApi, "startRepo">>;

const label = (level: Level) => level[0].toUpperCase() + level.slice(1);

/**
 * Who may do what in a repo: the caller's own permission and the repo's
 * visibility; to its admins, changing visibility, collaborators, and deleting
 * it (typing its name to confirm).
 */
export function RepoAdmin({ repo, access, manage, onDeleted, onChanged }: { repo: string; access: RepoAccess | undefined; manage: RepoManageApi; onDeleted: () => void; onChanged: () => void }) {
	const admin = canAdminister(access?.level);
	const loose = isLoose(repo);
	const [collaborators, setCollaborators] = useState<{ handle: string; permission: Level }[] | undefined>(undefined);
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
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

	const add = async (event: FormEvent) => {
		event.preventDefault();
		if (!handle.trim()) return;
		if (await run("add", () => manage.setCollaborator(repo, handle.trim().toLowerCase(), level))) {
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
					<dd>
						{access?.visibility === "public"
							? "Anyone signed in to GitHive can read it"
							: access?.visibility === "private"
								? "Only the owner's members and its collaborators"
								: loose
									? "GitHive's admins: it isn't in an organization yet"
									: "Loading…"}
					</dd>
				</dl>
				{admin && !loose && access?.visibility ? (
					<div className="manage__inline">
						<span className="manage__label">Make it</span>
						<button
							type="button"
							className="manage__small"
							disabled={busy === "visibility"}
							onClick={() => run("visibility", () => manage.setVisibility(repo, access.visibility === "public" ? "private" : "public")).then((ok) => ok && onChanged())}
						>
							{access.visibility === "public" ? "Private" : "Public"}
						</button>
						{errorFor("visibility")}
					</div>
				) : null}
			</div>

			{admin && !loose ? (
				<>
					<div className="box__header">
						<h2 id="repo-collaborators">Collaborators</h2>
					</div>
					{listError ? <p className="box__row error">{listError}</p> : null}
					{collaborators === undefined && !listError ? <p className="box__row muted">Loading…</p> : null}
					{collaborators?.length === 0 ? <p className="box__row muted">No collaborators: the owner's members have what the owner gives them.</p> : null}
					<ul className="manage__rows" aria-labelledby="repo-collaborators">
						{(collaborators ?? []).map((c) => {
							const key = `collab:${c.handle}`;
							return (
								<li key={c.handle} className="box__row">
									<div className="manage__row">
										<strong className="manage__row-main">{c.handle}</strong>
										<div className="manage__row-actions">
											<label className="sr-only" htmlFor={`collab-${c.handle}`}>
												{c.handle}'s permission
											</label>
											<select id={`collab-${c.handle}`} value={c.permission} disabled={busy === key} onChange={(e) => run(key, () => manage.setCollaborator(repo, c.handle, e.target.value as Level)).then((ok) => (ok ? load() : undefined))}>
												{LEVELS.map((l) => (
													<option key={l} value={l}>
														{label(l)}
													</option>
												))}
											</select>
											<ConfirmButton
												id={key}
												confirming={confirming}
												setConfirming={setConfirming}
												label="Remove"
												question={`Remove ${c.handle}?`}
												busy={busy === key}
												onConfirm={() => run(key, () => manage.removeCollaborator(repo, c.handle)).then((ok) => (ok ? load() : undefined))}
											/>
										</div>
									</div>
									{errorFor(key)}
								</li>
							);
						})}
					</ul>
					<form className="box__body manage__form" onSubmit={add}>
						<div className="manage__inline">
							<label className="sr-only" htmlFor="collab-handle">
								Handle
							</label>
							<input id="collab-handle" type="text" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="Their handle" autoComplete="off" spellCheck={false} />
							<label className="sr-only" htmlFor="collab-level">
								Permission
							</label>
							<select id="collab-level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
								{LEVELS.map((l) => (
									<option key={l} value={l}>
										{label(l)}
									</option>
								))}
							</select>
							<button type="submit" className="accent" disabled={!handle.trim() || busy === "add"}>
								Add collaborator
							</button>
						</div>
						<p className="manage__hint">They need to have signed in to GitHive once. Their agents act with the same permission.</p>
						{errorFor("add")}
					</form>
				</>
			) : null}

			{admin ? (
				<div className="box__body manage__form manage__danger">
					<h2>Delete this repository</h2>
					<p className="manage__note">
						This deletes its code, its history, GitHive's record of its claims, votes and merges, and its agents' forks. It can't be undone. Type <code>{repo}</code> to confirm.
					</p>
					<div className="manage__inline">
						<label className="sr-only" htmlFor="delete-confirm">
							Type {repo} to confirm
						</label>
						<input id="delete-confirm" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={repo} autoComplete="off" spellCheck={false} />
						<button type="button" className="danger" disabled={typed !== repo || busy === "delete"} onClick={() => run("delete", () => manage.deleteRepo(repo)).then((ok) => ok && onDeleted())}>
							{busy === "delete" ? "Deleting…" : "Delete repository"}
						</button>
					</div>
					{errorFor("delete")}
				</div>
			) : null}
		</section>
	);
}
