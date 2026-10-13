import { type FormEvent, type ReactNode, useState } from "react";
import type { GitHubSync, RepoGitHub, SettingsInput } from "../api";
import { useHeldDraft } from "../hooks/useHeldDraft";
import { messageOf } from "../lib/errors";
import { draftKey } from "../lib/settingsDrafts";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import type { SettingsContext } from "./MergeSettings";
import {
	COMMAND,
	failedStatus,
	SETTINGS_FIELDS,
	SettingField,
	SettingHint,
	SettingsPart,
	savedStatus,
} from "./SettingsParts";
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
import { Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/field";
import { TERMS } from "./ui/manage";
import { SaveBar } from "./ui/save-bar";

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

/** The form as held: the draft, whether the editor is open (a connected link shows read-only until Change…), and
 * whether anything was touched. */
interface GitHubForm extends GitHubDraft {
	editing: boolean;
	touched: boolean;
}

/** How GitHive's work reaches GitHub, as a choice with what it means. */
const syncChoices = (branch: string): { value: GitHubSync; title: string; means: string }[] => [
	{
		value: "pr",
		title: "Through a pull request",
		means: `GitHive keeps one pull request open from githive/main. Nothing reaches GitHub's ${branch} until someone merges it there.`,
	},
	{
		value: "mirror",
		title: `Pushed to ${branch}`,
		means: `After every landing GitHive pushes ${branch} to GitHub, so GitHub's ${branch} always matches. Nobody reviews it there first.`,
	},
];

/**
 * The repo's GitHub link, for admins. Connected, it reads as it is, with Change… to open the editor and Disconnect,
 * asked first; not connected, the editor: which GitHub repo (GitHive's GitHub App must be installed there), whether
 * GitHive's work reaches it through a pull request or is pushed to its main, and whether GitHub's changes come back
 * without review.
 */
export function GitHubSection({ repo, branch, snapshot, save, onSaved, drafts }: SettingsContext) {
	const { github } = snapshot;
	const fresh: GitHubForm = { ...githubDraft(github), editing: !github, touched: false };
	const inputOf = (form: GitHubForm) => githubInput(form, github, form.touched);
	const held = useHeldDraft(drafts, draftKey(repo, "github"), fresh, (form) => Object.keys(inputOf(form)).length > 0);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<ReactNode>(null);
	const form = held.draft;
	const input = inputOf(form);

	const edit = (patch: Partial<GitHubDraft>) => {
		setStatus(null);
		held.edit((current) => ({ ...current, ...patch, touched: true }));
	};
	const send = async (settings: SettingsInput, saved: string) => {
		setBusy(true);
		setStatus(null);
		try {
			await save(settings);
			held.discard();
			setStatus(savedStatus(saved));
			onSaved?.();
			return true;
		} catch (err) {
			setStatus(failedStatus(messageOf(err)));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const repoNow = form.repo.trim();
		void send(input, repoNow ? `Saved. Connected to ${repoNow}.` : "Saved. Not connected to GitHub.");
	};

	const description = (
		<>
			GitHive sends its work to a GitHub repo you can write to that has{" "}
			<a href={GITHUB_APP_URL} target="_blank" rel="noreferrer">
				GitHive's GitHub App
			</a>{" "}
			installed, and brings back whatever lands there, a merged pull request or commits pushed directly, as a change
			that goes through the checks like any other.
		</>
	);

	if (github && !form.editing)
		return (
			<SettingsPart id="settings-github" title="GitHub" description={description}>
				<Connected
					github={github}
					branch={branch}
					busy={busy}
					status={status}
					onChange={() => {
						setStatus(null);
						held.edit((current) => ({ ...current, editing: true }));
					}}
					onDisconnect={() => send({ github: "" }, `Saved. Disconnected from ${github.repo}.`)}
				/>
			</SettingsPart>
		);

	const connected = !!form.repo.trim();
	return (
		<form className="grid gap-4" onSubmit={submit} noValidate>
			<SettingsPart id="settings-github" title="GitHub" description={description}>
				<fieldset className={cn(SETTINGS_FIELDS, "m-0 min-w-0 border-0 px-0.5 py-4")} disabled={busy}>
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
							className={cn(COMMAND, "max-w-100")}
							value={form.repo}
							onChange={(event) => edit({ repo: event.target.value })}
							autoComplete="off"
							spellCheck={false}
							aria-describedby="github-repo-hint"
						/>
						<SettingHint id="github-repo-hint">
							Its owner and name, as its address on GitHub ends: owner/name.
						</SettingHint>
					</SettingField>
					<fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" disabled={!connected}>
						<legend className="mb-1 p-0 font-semibold">How GitHive's work reaches it</legend>
						<div className="grid grid-cols-2 gap-2 to-640:grid-cols-1">
							{syncChoices(branch).map((choice) => (
								<label
									key={choice.value}
									className={cn(
										"flex cursor-pointer items-start gap-2.5 rounded-md border border-input bg-card p-3",
										"transition-[background-color,border-color] duration-fast",
										"has-checked:border-link has-checked:bg-link-soft has-disabled:cursor-not-allowed has-disabled:opacity-55",
									)}
								>
									<input
										type="radio"
										name="github-sync"
										value={choice.value}
										className="mt-1 shrink-0"
										checked={form.sync === choice.value}
										onChange={() => edit({ sync: choice.value })}
									/>
									<span className="grid gap-0.5">
										<span className="font-semibold">{choice.title}</span>
										<span className="text-ui text-muted-foreground">{choice.means}</span>
									</span>
								</label>
							))}
						</div>
					</fieldset>
					<Label className="flex items-start gap-2 font-normal">
						{/* The browser's own margins about a checkbox. */}
						<input
							type="checkbox"
							className="mt-1.25 mr-0.75 mb-0.75 ml-1"
							checked={form.trust}
							disabled={!connected}
							onChange={(event) => edit({ trust: event.target.checked })}
						/>
						<span>Trust GitHub's changes: they land without review (their checks still run)</span>
					</Label>
				</fieldset>
			</SettingsPart>
			<SaveBar
				status={status}
				dirty={Object.keys(input).length > 0}
				// A connected link's editor closes again with nothing changed.
				canDiscard={!!github}
				busy={busy}
				onDiscard={() => {
					setStatus(null);
					held.discard();
				}}
				discardLabel={github ? "Cancel" : "Discard"}
				saveLabel={github ? "Save" : "Connect"}
			/>
		</form>
	);
}

/** A connected link, read-only: where it goes, how, and whether GitHub's changes come back reviewed. */
function Connected({
	github,
	branch,
	busy,
	status,
	onChange,
	onDisconnect,
}: {
	github: RepoGitHub;
	branch: string;
	busy: boolean;
	status: ReactNode;
	onChange(): void;
	onDisconnect(): Promise<boolean>;
}) {
	const how =
		github.sync === "pr"
			? "Through a pull request from githive/main, merged on GitHub"
			: `Pushed to ${branch} after every landing`;
	let back = github.trust ? "Land without review; their checks still run" : "Reviewed like any change";
	if (!github.inbound) back = `Not brought back: connected before GitHive had modes, it only mirrors ${branch}`;
	return (
		<div className="grid gap-4 px-0.5 py-4">
			<p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-body-sm">
				<Icon name="check-circle" className="text-good" />
				<span>
					Connected to{" "}
					<a href={`https://github.com/${github.repo}`} target="_blank" rel="noreferrer" className="font-semibold">
						{github.repo}
					</a>
				</span>
				{github.pull ? (
					<span>
						{"· "}
						<a href={github.pull.url} target="_blank" rel="noreferrer">
							Pull request #{github.pull.number}
						</a>
					</span>
				) : null}
			</p>
			<dl className={TERMS}>
				<dt>GitHive's work</dt>
				<dd>{how}</dd>
				<dt>GitHub's changes</dt>
				<dd>{back}</dd>
			</dl>
			<div className="flex flex-wrap gap-2">
				<Button onClick={onChange} disabled={busy}>
					Change…
				</Button>
				<Disconnect github={github} busy={busy} onDisconnect={onDisconnect} />
			</div>
			<p className="m-0 text-ui" role="status">
				{status}
			</p>
		</div>
	);
}

/** Disconnecting, asked first in a dialog: what stops, and what stays. */
function Disconnect({
	github,
	busy,
	onDisconnect,
}: {
	github: RepoGitHub;
	busy: boolean;
	onDisconnect(): Promise<boolean>;
}) {
	const [open, setOpen] = useState(false);
	const stays = github.pull ? "the open pull request stays" : "what's there stays";
	return (
		<AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
			<AlertDialogTrigger asChild>
				<Button variant="danger" disabled={busy}>
					Disconnect
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Disconnect {github.repo}?</AlertDialogTitle>
					<AlertDialogDescription>
						GitHive stops pushing to {github.repo}; {stays}. Whatever lands on GitHub from now on isn't brought back.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>Keep connected</AlertDialogCancel>
					<Button
						variant="danger"
						disabled={busy}
						// Done or not, the dialog closes: the section's status line says which.
						onClick={() => void onDisconnect().then(() => setOpen(false))}
					>
						{busy ? "Disconnecting…" : "Disconnect"}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
