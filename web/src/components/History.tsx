import type { BranchHistory, LandedChange } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { useStagger } from "../hooks/useStagger";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { COMMIT_LIST, COMMIT_META, COMMIT_SUBJECT, CommitRow, CommitsBox } from "./Commits";
import { Icon } from "./Icon";
import { Box } from "./ui/box";
import { Empty } from "./ui/empty";

export interface HistoryApi {
	history?: (repo: string, branch: string) => Promise<BranchHistory>;
}

/** The History tab: the changes landed on the branch, loaded here and kept fresh. */
export function HistoryTab({ repo, branch, api }: { repo: string; branch: string; api: HistoryApi }) {
	const load = api.history;
	const poll = usePoll(load ? `history:${repo}:${branch}` : null, () => load!(repo, branch), 60_000);
	return <History repo={repo} history={poll.data} error={poll.data ? undefined : poll.error} />;
}

/** Each change landed on the branch, newest first: why it was made, who made it, and who approved it. */
export interface HistoryProps {
	repo: string;
	history: BranchHistory | undefined;
	error?: unknown;
}

export function History({ repo, history, error }: HistoryProps) {
	// What loads fades in where "Loading" was: the changes, that there are none, or that they couldn't be read.
	const phase = history ? (history.changes.length ? "list" : "empty") : error ? "error" : "loading";
	const fades = useChanged(phase) && "animate-fade";
	if (!history) {
		const status = error ? "The history couldn't be loaded." : "Loading history…";
		return (
			<p key={phase} className={cn("my-3.75 text-muted-foreground", fades)} role="status">
				{status}
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

/** The changes, newest first; one landed since they first showed fades in. */
function HistoryRows({ repo, changes }: { repo: string; changes: LandedChange[] }) {
	const arrived = useArrivals(changes.map((landed) => landed.commit));
	const staggers = useStagger(changes.length > 0);
	return (
		<ol className={cn(COMMIT_LIST, staggers && "stagger")}>
			{changes.map((landed) => (
				<HistoryRow key={landed.commit} repo={repo} landed={landed} arrived={arrived(landed.commit)} />
			))}
		</ol>
	);
}

function HistoryRow({ repo, landed, arrived }: { repo: string; landed: LandedChange; arrived: boolean }) {
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
				{landed.files.length ? <span> · {fileCount(landed.files.length)}</span> : null}
			</p>
			{landed.reviews.length ? (
				<Reviews reviews={landed.reviews} />
			) : (
				<p className="mt-1.5 mb-0 text-ui text-muted-foreground">Landed without review.</p>
			)}
		</CommitRow>
	);
}

function Reviews({ reviews }: { reviews: LandedChange["reviews"] }) {
	return (
		<ul className="mt-1.5 mb-0 grid list-none gap-1 p-0 text-ui">
			{reviews.map((review) => (
				<li
					key={`${review.reviewer}:${review.role}:${review.verdict}`}
					className="flex items-baseline gap-1.5 wrap-anywhere"
				>
					<Icon
						name={review.verdict === "approve" ? "check-circle" : "x-circle"}
						size={14}
						label={review.verdict}
						className="shrink-0 self-center"
					/>
					<strong>{review.reviewer}</strong> <span className="text-muted-foreground">({review.role})</span>{" "}
					{review.evidence}
				</li>
			))}
		</ul>
	);
}

const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
