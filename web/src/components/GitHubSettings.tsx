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

/** The form's draft for a repo's link: a new connection goes through a pull request and trusts GitHub. */
export const githubDraft = (github: RepoGitHub | undefined): GitHubDraft => ({
	repo: github?.repo ?? "",
	sync: github?.sync ?? "pr",
	trust: github?.trust ?? true,
});

/** The settings call for a draft: only what changed, and "" for the repo to disconnect it. */
export function githubInput(draft: GitHubDraft, github: RepoGitHub | undefined): SettingsInput {
	const repo = draft.repo.trim();
	if (!repo) return github ? { github: "" } : {};
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
	useEffect(() => setDraft(JSON.parse(fresh) as GitHubDraft), [fresh]);
	const input = githubInput(draft, github);
	const dirty = Object.keys(input).length > 0;
	const edit = (patch: Partial<GitHubDraft>) => {
		setSaved(false);
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
						A GitHub repo GitHive's GitHub app is installed on. Whatever GitHub's branch gains (the pull request's
						merge, or commits pushed there) comes back as a change by githive-github, landing through the checks.
					</p>
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
