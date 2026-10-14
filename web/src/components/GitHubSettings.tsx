import { type FormEvent, useEffect, useState } from "react";
import type { GitHubSync, RepoGitHub, SavedMergeSettings, SettingsInput } from "../api";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import { COMMAND, SaveBar, SETTINGS_FIELDS, SETTINGS_FORM, SettingField, SettingsSection } from "./MergeSettings";
import { Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Input, Label, NativeSelect } from "./ui/field";

// Where anyone installs the App on their own account or org, choosing which repos it may reach.
export const GITHUB_APP_URL = "https://github.com/apps/githiveapp";

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
		<form className={SETTINGS_FORM} onSubmit={submit}>
			<SettingsSection id="settings-github" title="GitHub">
				{/* A fieldset, with the frame and side margins a fieldset has. */}
				<fieldset
					className={cn(SETTINGS_FIELDS, "mx-0.5 min-w-min px-0.5 py-4 [border:2px_groove_ThreeDFace]")}
					disabled={busy}
				>
					<p className="m-0 text-muted-foreground">
						Connect this repo to a GitHub repo you can write to that has{" "}
						<a href={GITHUB_APP_URL} target="_blank" rel="noreferrer">
							GitHive's GitHub App
						</a>{" "}
						installed. GitHive sends its work there, and brings back whatever lands on GitHub, a merged pull request or
						commits pushed there directly, as a change that goes through the checks like any other.
					</p>
					{github && !github.inbound ? (
						<Callout className="block">
							Connected before GitHive had modes: it mirrors {branch} to GitHub and brings nothing back. Choosing a mode
							here and saving brings GitHub's changes back from then on.
						</Callout>
					) : null}
					<SettingField>
						<Label htmlFor="github-repo">GitHub repo</Label>
						<Input
							id="github-repo"
							className={COMMAND}
							placeholder="owner/name"
							value={draft.repo}
							onChange={(event) => edit({ repo: event.target.value })}
						/>
					</SettingField>
					<SettingField>
						<Label htmlFor="github-sync">How GitHive's work reaches it</Label>
						<NativeSelect
							id="github-sync"
							value={draft.sync}
							disabled={!connected}
							onChange={(event) => edit({ sync: event.target.value as GitHubSync })}
						>
							<option value="pr">Through one pull request from githive/main, merged on GitHub</option>
							<option value="mirror">Pushed to GitHub's {branch} after every landing</option>
						</NativeSelect>
					</SettingField>
					<Label className="flex items-start gap-2 font-normal">
						{/* On the first line's letters, which sit high in their line, however many lines the text takes. */}
						<input
							type="checkbox"
							className="m-0 mt-0.75 shrink-0"
							checked={draft.trust}
							disabled={!connected}
							onChange={(event) => edit({ trust: event.target.checked })}
						/>
						Trust GitHub's changes: they land without review (their checks still run)
					</Label>
				</fieldset>
			</SettingsSection>
			<SaveBar>
				{error ? (
					<p className="mt-0 mb-2 animate-appear text-bad" role="alert">
						{error}
					</p>
				) : null}
				{saved && !dirty ? <p className="mt-0 mb-2 animate-appear text-good">GitHub settings saved.</p> : null}
				<Button type="submit" variant="go" disabled={busy || !dirty}>
					{busy ? "Saving…" : "Save GitHub settings"}
				</Button>
			</SaveBar>
		</form>
	);
}
