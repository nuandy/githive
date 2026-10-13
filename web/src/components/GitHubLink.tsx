import { useState } from "react";
import type { PullAnswer, RepoGitHub } from "../api";
import { messageOf } from "../lib/errors";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Button } from "./ui/button";

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
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ui">
			<a className="inline-flex items-center gap-1" href={`https://github.com/${github.repo}`} title={mode}>
				<Icon name="repo" size={14} />
				{github.repo}
			</a>
			{github.sync === "pr" && pull ? (
				<a
					className="inline-flex items-center gap-1"
					href={pull.url}
					title="The standing pull request from githive/main"
				>
					<Icon name="pull" size={14} />
					Pull request #{pull.number}
				</a>
			) : null}
			{github.sync === "pr" && !pull && openPull ? (
				<Button size="sm" className="gap-1 py-0.5" onClick={open} disabled={busy}>
					<Icon name="pull" size={14} />
					{busy ? "Opening…" : "Open a pull request on GitHub"}
				</Button>
			) : null}
			{github.sync === "mirror" ? <span className="text-muted-foreground">mirrored</span> : null}
			{note ? (
				<span className={cn("max-w-[48ch] wrap-anywhere", job?.step === "needs a person" ? "text-needs" : "text-warn")}>
					{job?.change && job.step !== "failed" ? <a href={href.change(repo, job.change)}>{note}</a> : note}
				</span>
			) : null}
			{stopped && again ? (
				<Button size="sm" className="gap-1 py-0.5" onClick={tryAgain} disabled={busy}>
					{busy ? "Asking…" : "Bring them in again"}
				</Button>
			) : null}
			{error ? <span className="basis-full animate-appear text-bad">{error}</span> : null}
		</div>
	);
}
