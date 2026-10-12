import { type FormEvent, useEffect, useState } from "react";
import type { GitHubSync, RepoGitHub, SavedMergeSettings, SettingsInput } from "../api";
import { messageOf } from "../lib/errors";
import "./RepoSettings.css";

/** What the form holds: the GitHub repo, how GitHive's work reaches it, and whether its changes need review. */
export interface GitHubDraft {
	repo: string;
	sync: GitHubSync;
	trust: boolean;
}

/**
 * The form's draft for a repo's link: a new connection goes through a pull request and trusts GitHub. A link made
 * before modes shows the mirror it is, and trust as a mode would start it.
 */
export const githubDraft = (github: RepoGitHub | undefined): GitHubDraft => ({
	repo: github?.repo ?? "",
	sync: github?.sync ?? "pr",
	trust: github && !github.inbound ? true : (github?.trust ?? true),
});

/**
 * The settings call for a draft: only what changed, and "" for the repo to disconnect it. Saving a link made before
 * modes sets its mode and trust, which brings GitHub's changes back from then on, so it's sent only once someone
 * `touched` the form: an untouched form has nothing to save.
 */
export function githubInput(draft: GitHubDraft, github: RepoGitHub | undefined, touched = true): SettingsInput {
	const repo = draft.repo.trim();
	if (!repo) return github ? { github: "" } : {};
	if (github && !github.inbound && repo === github.repo)
		return touched ? { github_sync: draft.sync, github_trust: draft.trust } : {};
	const input: SettingsInput = {};
	if (repo !== github?.repo) input.github = repo;
	if (draft.sync !== (github?.sync ?? "pr")) input.github_sync = draft.sync;
	if (draft.trust !== (github?.trust ?? true)) input.github_trust = draft.trust;
	return input;
}

/**
 * The repo's GitHub link, for admins: which GitHub repo (GitHive's GitHub app must be installed there), whether
 * GitHive's work reaches it through a pull request or is pushed to its main, and whether GitHub's changes come back
 * without review.
 */
export function GitHubSettings({
	branch,
	github,
	save,
	onSaved,
}: {
	branch: string;
	github: RepoGitHub | undefined;
	save(settings: SettingsInput): Promise<SavedMergeSettings>;
	onSaved?(): void;
}) {
	const fresh = JSON.stringify(githubDraft(github));
	const [draft, setDraft] = useState<GitHubDraft>(() => githubDraft(github));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [touched, setTouched] = useState(false);
	useEffect(() => {
		setDraft(JSON.parse(fresh) as GitHubDraft);
		setTouched(false);
	}, [fresh]);
	const input = githubInput(draft, github, touched);
	const dirty = Object.keys(input).length > 0;
	const edit = (patch: Partial<GitHubDraft>) => {
		setSaved(false);
		setTouched(true);
		setDraft((current) => ({ ...current, ...patch }));
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await save(input);
			setSaved(true);
			onSaved?.();
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	const connected = !!draft.repo.trim();
	return (
		<form className="repo-settings__form" onSubmit={submit}>
			<section className="box" aria-labelledby="settings-github">
				<div className="box__header">
					<h2 id="settings-github">GitHub</h2>
				</div>
				<fieldset className="box__body repo-settings__fields" disabled={busy}>
					<p className="muted">
						Connect this repo to a GitHub repo that has GitHive's GitHub App installed. GitHive sends its work there,
						and brings back whatever lands on GitHub, a merged pull request or commits pushed there directly, as a
						change that goes through the checks like any other.
					</p>
					{github && !github.inbound ? (
						<p className="callout">
							Connected before GitHive had modes: it mirrors {branch} to GitHub and brings nothing back. Choosing a mode
							here and saving brings GitHub's changes back from then on.
						</p>
					) : null}
					<div className="repo-settings__field">
						<label htmlFor="github-repo">GitHub repo</label>
						<input
							id="github-repo"
							className="repo-settings__command"
							placeholder="owner/name"
							value={draft.repo}
							onChange={(event) => edit({ repo: event.target.value })}
						/>
					</div>
					<div className="repo-settings__field">
						<label htmlFor="github-sync">How GitHive's work reaches it</label>
						<select
							id="github-sync"
							value={draft.sync}
							disabled={!connected}
							onChange={(event) => edit({ sync: event.target.value as GitHubSync })}
						>
							<option value="pr">Through one pull request from githive/main, merged on GitHub</option>
							<option value="mirror">Pushed to GitHub's {branch} after every landing</option>
						</select>
					</div>
					<label className="repo-settings__check">
						<input
							type="checkbox"
							checked={draft.trust}
							disabled={!connected}
							onChange={(event) => edit({ trust: event.target.checked })}
						/>{" "}
						Trust GitHub's changes: they land without review (their checks still run)
					</label>
				</fieldset>
			</section>
			<div className="repo-settings__save">
				{error ? (
					<p className="error" role="alert">
						{error}
					</p>
				) : null}
				{saved && !dirty ? <p className="tone-good">GitHub settings saved.</p> : null}
				<button type="submit" className="primary" disabled={busy || !dirty}>
					{busy ? "Saving…" : "Save GitHub settings"}
				</button>
			</div>
		</form>
	);
}
