import { useState } from "react";
import type { BranchHistory, LandedChange } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { useStagger } from "../hooks/useStagger";
import { batchesOf, batchWords } from "../lib/landed";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { COMMIT_LIST, COMMIT_META, COMMIT_SUBJECT, CommitRow, CommitsBox } from "./Commits";
import { Icon } from "./Icon";
import { LoadError } from "./LoadError";
import { Box } from "./ui/box";
import { Button } from "./ui/button";
import { Fold } from "./ui/collapse";
import { Empty } from "./ui/empty";

export interface HistoryApi {
	history?: (repo: string, branch: string) => Promise<BranchHistory>;
}

/** The History tab: the changes landed on the branch, loaded here and kept fresh. */
export function HistoryTab({ repo, branch, api }: { repo: string; branch: string; api: HistoryApi }) {
	const load = api.history;
	const poll = usePoll(load ? `history:${repo}:${branch}` : null, () => load!(repo, branch), 60_000);
	return <History repo={repo} history={poll.data} error={poll.data ? undefined : poll.error} onRetry={poll.refresh} />;
}

/** Each change landed on the branch, newest first: why it was made, who made it, and who approved it. */
export interface HistoryProps {
	repo: string;
	history: BranchHistory | undefined;
	/** Why it couldn't be loaded, while there's none to show. */
	error?: string;
	onRetry?: () => void;
}

export function History({ repo, history, error, onRetry }: HistoryProps) {
	// What loads fades in where "Loading" was: the changes, that there are none, or that they couldn't be read.
	const phase = history ? (history.changes.length ? "list" : "empty") : error ? "error" : "loading";
	const fades = useChanged(phase) && "animate-fade";
	if (!history) {
		if (error)
			return <LoadError key={phase} what="The history" error={error} onRetry={onRetry} className={cn(fades)} />;
		return (
			<p key={phase} className={cn("my-3.75 text-muted-foreground", fades)} role="status">
				Loading history…
			</p>
		);
	}
	if (!history.changes.length) {
		return (
			<Box asChild className={cn(fades)}>
				<Empty>
					<Icon name="commit" size={28} />
					<h2>Nothing has landed on {history.branch} yet</h2>
					<p>Each change that lands shows here, with why it was made and who reviewed it.</p>
				</Empty>
			</Box>
		);
	}
	const shown = history.changes.length;
	const more = history.total - shown;
	return (
		<CommitsBox
			id="history-title"
			heading={
				<>
					{history.total} {history.total === 1 ? "change" : "changes"} landed on {history.branch}
				</>
			}
			className={cn(fades)}
		>
			<HistoryRows repo={repo} changes={history.changes} />
			{more > 0 ? (
				<p className="mt-1.5 mb-0 border-t border-border px-4 py-2.5 text-ui text-muted-foreground">
					And {more} earlier, in the branch's own history.
				</p>
			) : null}
		</CommitsBox>
	);
}

/**
 * The changes, newest first, those that landed together under a quiet heading (landed.ts); one landed since they first
 * showed fades in.
 */
function HistoryRows({ repo, changes }: { repo: string; changes: LandedChange[] }) {
	const arrived = useArrivals(changes.map((landed) => landed.commit));
	const staggers = useStagger(changes.length > 0);
	const row = (landed: LandedChange) => (
		<HistoryRow key={landed.commit} repo={repo} landed={landed} arrived={arrived(landed.commit)} />
	);
	return (
		<ol className={cn(COMMIT_LIST, staggers && "stagger")}>
			{batchesOf(changes).map((batch) =>
				batch.at && batch.changes.length > 1 ? (
					<li key={`batch:${batch.changes[0]!.commit}`} className="border-t border-border first:border-t-0">
						<p className="m-0 flex items-center gap-1.5 px-4 pt-2.5 text-caption font-semibold text-muted-foreground">
							<Icon name="merge" size={14} />
							<time dateTime={batch.at}>{batchWords(batch.at, batch.changes.length)}</time>
						</p>
						{/* Ruled down its side, so its changes read as one landing. */}
						<ol className={cn(COMMIT_LIST, "mt-1.5 mb-2 ml-5.5 border-l-2 border-border to-560:ml-2")}>
							{batch.changes.map(row)}
						</ol>
					</li>
				) : (
					batch.changes.map(row)
				),
			)}
		</ol>
	);
}

/** A landed change: what it set out to do, who landed it and when, the files it changed (folded), and its reviews. */
function HistoryRow({ repo, landed, arrived }: { repo: string; landed: LandedChange; arrived: boolean }) {
	const [open, setOpen] = useState(false);
	const files = `history-files-${landed.commit}`;
	return (
		<CommitRow icon="merge" repo={repo} commit={landed.commit} arrived={arrived}>
			<p className={COMMIT_SUBJECT}>
				<a href={href.change(repo, landed.change)}>{landed.title}</a>
			</p>
			<p className={COMMIT_META}>
				<strong>{landed.agent}</strong> landed <code>{landed.change}</code>
				{landed.at ? (
					<>
						{" "}
						<time dateTime={landed.at} title={new Date(landed.at).toLocaleString()}>
							{timeAgo(landed.at)}
						</time>
					</>
				) : null}
				{landed.files.length ? (
					<>
						<span aria-hidden="true">·</span>
						<Button
							variant="link"
							className="touch-target inline-flex items-center gap-0.5 text-meta"
							aria-expanded={open}
							aria-controls={files}
							onClick={() => setOpen(!open)}
						>
							{fileCount(landed.filesTotal ?? landed.files.length)}
							<Icon
								name="chevron"
								size={14}
								className={cn("transition-transform duration-fast ease-out", !open && "-rotate-90")}
							/>
						</Button>
					</>
				) : null}
			</p>
			<Fold open={open} id={files}>
				<LandedFiles repo={repo} landed={landed} />
			</Fold>
			{landed.reviews.length ? (
				<Reviews reviews={landed.reviews} />
			) : (
				<p className="mt-1.5 mb-0 text-ui text-muted-foreground">Landed without review.</p>
			)}
		</CommitRow>
	);
}

/** The files a change landed, each linked to the code as it landed, and how many more than it lists there are. */
export function LandedFiles({
	repo,
	landed,
}: {
	repo: string;
	landed: Pick<LandedChange, "commit" | "files" | "filesTotal">;
}) {
	const more = (landed.filesTotal ?? landed.files.length) - landed.files.length;
	return (
		<ul className="m-0 grid list-none gap-0.5 py-1.5 pl-0.5">
			{landed.files.map((file) => (
				<li key={file} className="min-w-0">
					<a
						href={href.code(repo, file, landed.commit)}
						className="inline-flex max-w-full items-center gap-1.5 font-mono text-caption wrap-anywhere"
					>
						<Icon name="file" size={14} className="flex-none text-muted-foreground" />
						{file}
					</a>
				</li>
			))}
			{more > 0 ? <li className="pl-5 text-caption text-muted-foreground">and {more} more</li> : null}
		</ul>
	);
}

function Reviews({ reviews }: { reviews: LandedChange["reviews"] }) {
	return (
		<ul className="mt-1.5 mb-0 grid list-none gap-1 p-0 text-ui">
			{reviews.map((review) => (
				// Its icon hangs before the first line, and the words wrap under each other, not under the icon.
				<li key={`${review.reviewer}:${review.role}:${review.verdict}`} className="pl-5 -indent-5 wrap-anywhere">
					<Icon
						name={review.verdict === "approve" ? "check-circle" : "x-circle"}
						size={14}
						label={review.verdict}
						className="mr-1.5 inline -mb-0.5 align-baseline"
					/>
					<strong>{review.reviewer}</strong> <span className="text-muted-foreground">({review.role})</span>{" "}
					{review.evidence}
				</li>
			))}
		</ul>
	);
}

const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
