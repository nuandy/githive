import { useState } from "react";
import type { PullAnswer, RepoGitHub } from "../api";
import { messageOf } from "../lib/errors";
import { href } from "../lib/routes";
import { Icon } from "./Icon";
import "./GitHubLink.css";

/** Where bringing GitHub's changes back stands, in words, when it needs anyone to know. */
export function fromGitHubWords(github: RepoGitHub): string | null {
	const job = github.fromGitHub;
	if (!job) return null;
	if (job.step === "needs a person") return `GitHub's changes need a person: ${job.reason ?? "they were sent back"}`;
	if (job.step === "given up") return `GitHub's changes were given up: ${job.reason ?? "their claim was released"}`;
	if (job.step === "waiting") return `GitHub's changes ${job.reason ?? "wait"}`;
	if (job.step === "failed") return `Bringing GitHub's changes back failed: ${job.reason ?? "no reason given"}`;
	if (job.step === "import" || job.step === "claim" || job.step === "merge") return "Bringing GitHub's changes back…";
	return null;
}

/**
 * By the repo's name: the GitHub repo it's connected to, and in pr mode the standing pull request, with a button to
 * open it for people who can write. Merging and closing it happen on GitHub.
 */
export function GitHubLink({
	repo,
	github,
	openPull,
	again,
	onChanged,
}: {
	repo: string;
	github: RepoGitHub;
	/** For people who can write: open the pull request (or find it). */
	openPull?: (repo: string) => Promise<PullAnswer>;
	/** For people who can write: bring GitHub's changes back again, after they were given up, sent back or failed. */
	again?: (repo: string) => Promise<unknown>;
	onChanged?: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [opened, setOpened] = useState<PullAnswer | null>(null);
	const [asked, setAsked] = useState(false);
	const pull = opened ? { number: opened.number, url: opened.pr } : github.pull;
	const act = async (run: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await run();
			onChanged?.();
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	const open = () =>
		act(async () => {
			if (openPull) setOpened(await openPull(repo));
		});
	const tryAgain = () =>
		act(async () => {
			if (!again) return;
			await again(repo);
			setAsked(true);
		});
	const job = github.fromGitHub;
	const note = asked ? "Bringing GitHub's changes back…" : fromGitHubWords(github);
	const stopped = !asked && (job?.step === "given up" || job?.step === "needs a person" || job?.step === "failed");
	const mode =
		github.sync === "pr"
			? "GitHive's work reaches it through a pull request"
			: "GitHive pushes main there after every landing";
	return (
		<div className="github-link">
			<a className="github-link__repo" href={`https://github.com/${github.repo}`} title={mode}>
				<Icon name="repo" size={14} />
				{github.repo}
			</a>
			{github.sync === "pr" && pull ? (
				<a className="github-link__pull" href={pull.url} title="The standing pull request from githive/main">
					<Icon name="pull" size={14} />
					Pull request #{pull.number}
				</a>
			) : null}
			{github.sync === "pr" && !pull && openPull ? (
				<button type="button" className="github-link__open" onClick={open} disabled={busy}>
					<Icon name="pull" size={14} />
					{busy ? "Opening…" : "Open a pull request on GitHub"}
				</button>
			) : null}
			{github.sync === "mirror" ? <span className="muted">mirrored</span> : null}
			{note ? (
				<span className={`github-link__note tone-${job?.step === "needs a person" ? "needs" : "warn"}`}>
					{job?.change && job.step !== "failed" ? <a href={href.change(repo, job.change)}>{note}</a> : note}
				</span>
			) : null}
			{stopped && again ? (
				<button type="button" className="github-link__open" onClick={tryAgain} disabled={busy}>
					{busy ? "Asking…" : "Bring them in again"}
				</button>
			) : null}
			{error ? <span className="error github-link__error">{error}</span> : null}
		</div>
	);
}
