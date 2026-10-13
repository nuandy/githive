import type { ReactNode } from "react";
import type { ChangeHistory } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useStagger } from "../hooks/useStagger";
import { shortSha } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { Box, BoxHeader } from "./ui/box";
import { Empty } from "./ui/empty";

// Lists of commits: a change's own (here) and the changes landed on a branch (History). A row is an icon, what it
// says, and its commit, linked to the code at it.

/** Commits, or changes landed, in a box under a heading that counts them. */
export function CommitsBox({
	id,
	heading,
	className,
	children,
}: {
	id: string;
	heading: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Box aria-labelledby={id} className={className}>
			<BoxHeader>
				<h2 id={id} className="text-body-sm">
					{heading}
				</h2>
			</BoxHeader>
			{children}
		</Box>
	);
}

export const COMMIT_LIST = "m-0 list-none p-0";
/** A row's first line: what the commit or change says. */
export const COMMIT_SUBJECT = "m-0 flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold wrap-anywhere";
/** Who made it and when. */
export const COMMIT_META =
	"mt-0.5 mb-0 flex flex-wrap items-center gap-1 text-meta wrap-anywhere text-muted-foreground";

/** One row; on a phone its commit goes under what it says. One that comes after the list first showed fades in. */
export function CommitRow({
	icon,
	repo,
	commit,
	arrived,
	children,
}: {
	icon: IconName;
	repo: string;
	commit: string;
	arrived: boolean;
	children: ReactNode;
}) {
	return (
		<li
			className={cn(
				"flex items-start gap-2.5 border-t border-border px-4 py-2.5 first:border-t-0 to-560:flex-wrap",
				arrived && "animate-appear",
			)}
		>
			<Icon name={icon} className="mt-0.75 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">{children}</div>
			<a className="shrink-0 text-meta whitespace-nowrap to-560:ml-6.5" href={href.code(repo, "", commit)}>
				<code>{shortSha(commit)}</code>
			</a>
		</li>
	);
}

function When({ at }: { at: string }) {
	return (
		<time dateTime={at} title={new Date(at).toLocaleString()}>
			{timeAgo(at)}
		</time>
	);
}

/** The commits of a list that has some, newest first, with their messages; a longer message unfolds. */
function CommitRows({ commits, repo }: { commits: ChangeHistory["commits"]; repo: string }) {
	const arrived = useArrivals(commits.map((commit) => commit.commit));
	const staggers = useStagger(commits.length > 0);
	return (
		<ol className={cn(COMMIT_LIST, staggers && "stagger")}>
			{commits.map((commit) => {
				const [subject, ...bodyLines] = commit.message.split("\n");
				const body = bodyLines.join("\n").trim();
				return (
					<CommitRow
						key={commit.commit}
						icon="commit"
						repo={repo}
						commit={commit.commit}
						arrived={arrived(commit.commit)}
					>
						<p className={COMMIT_SUBJECT}>{subject || "(no message)"}</p>
						{body ? (
							<details className="disclosure">
								{/* The browser's disclosure triangle, written out. */}
								<summary className="list-item cursor-pointer list-inside list-[disclosure-closed] text-meta text-muted-foreground [[open]>&]:list-[disclosure-open]">
									More
								</summary>
								<pre className="mt-1 mb-0 text-caption">{body}</pre>
							</details>
						) : null}
						<p className={COMMIT_META}>
							<strong>{commit.author || "someone"}</strong> committed <When at={commit.at} />
						</p>
					</CommitRow>
				);
			})}
		</ol>
	);
}

/** A change's own commits, newest first, with their messages. Once they load, they fade in where "Loading" was. */
export function ChangeCommits({ history, repo }: { history: ChangeHistory | undefined; repo: string }) {
	const phase = !history ? "loading" : history.commits.length ? "list" : "empty";
	const fades = useChanged(phase) && "animate-appear";
	if (!history)
		return (
			<p className="my-3.75 text-muted-foreground" role="status">
				Loading commits…
			</p>
		);
	if (!history.commits.length)
		return (
			<Box asChild className={cn(fades)}>
				<Empty>
					<Icon name="commit" size={28} />
					<h2>No commits yet</h2>
					<p>Commits show up here as the agent pushes them to its branch.</p>
				</Empty>
			</Box>
		);
	return (
		<CommitsBox
			id="commits-title"
			heading={
				<>
					{history.commits.length} {history.commits.length === 1 ? "commit" : "commits"}
				</>
			}
			className={cn(fades)}
		>
			<CommitRows commits={history.commits} repo={repo} />
		</CommitsBox>
	);
}
