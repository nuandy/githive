import type { ReactNode } from "react";
import type { RepoSnapshot } from "../api";
import { HostedAgents, type HostedAgentsApi } from "./HostedAgents";
import { authorStats, reviewerStats, type AuthorStats, type ReviewerStats } from "../lib/people";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import { cn } from "../lib/utils";
import { Box, BoxHeader } from "./ui/box";
import { LINE } from "./ui/manage";

// The tab's tables: a row a line, ruled, its figures in even widths.
const TABLE = [
	"w-full border-collapse text-ui",
	"[&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-2.25 [&_td]:text-left [&_td]:whitespace-nowrap",
	"[&_th]:border-t [&_th]:border-border [&_th]:px-4 [&_th]:py-2.25 [&_th]:text-left [&_th]:whitespace-nowrap",
	"[&_thead_th]:border-t-0 [&_thead_th]:text-caption [&_thead_th]:font-semibold [&_thead_th]:text-muted-foreground",
	"[&_tbody_th]:font-semibold",
	"[&_td:not(:nth-child(2))]:tabular-nums [&_thead_th:not(:first-child)]:tabular-nums",
].join(" ");
// An agent's or a reviewer's mark beside its name, sitting on the text.
const MARK = "mr-1 inline align-[-2px] text-muted-foreground";
// A line under the header in place of the table.
const NONE = cn(LINE, "text-muted-foreground");

/** A section of the tab, under its title. */
function AgentsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
	return (
		<Box aria-labelledby={id}>
			<BoxHeader>
				<h2 id={id} className="text-body-sm">
					{title}
				</h2>
			</BoxHeader>
			{children}
		</Box>
	);
}

/** GitHive's own agents, whose names start githive-, and its one-off builder. */
const isGitHiveAgent = (name: string) => name === "GitHive builder" || name.startsWith("githive-");

function Authors({ authors }: { authors: AuthorStats[] }) {
	return (
		<AgentsSection id="agents-authors" title="Who opens changes">
			{authors.length ? (
				<div className="overflow-x-auto">
					<table className={TABLE}>
						<thead>
							<tr>
								<th scope="col">Agent</th>
								<th scope="col">Claims in force</th>
								<th scope="col">Last active</th>
							</tr>
						</thead>
						<tbody>
							{authors.map((author) => (
								<tr key={author.name}>
									<th scope="row">
										<Icon name={isGitHiveAgent(author.name) ? "bot" : "user"} size={14} className={MARK} />{" "}
										{author.name}
									</th>
									<td>{author.open}</td>
									<td className="text-muted-foreground">{author.lastActive ? timeAgo(author.lastActive) : "–"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className={NONE}>No changes yet.</p>
			)}
		</AgentsSection>
	);
}

function Reviewers({ reviewers }: { reviewers: ReviewerStats[] }) {
	return (
		<AgentsSection id="agents-reviewers" title="Who reviews">
			{reviewers.length ? (
				<div className="overflow-x-auto">
					<table className={TABLE}>
						<thead>
							<tr>
								<th scope="col">Reviewer</th>
								<th scope="col">Roles</th>
								<th scope="col">Approved</th>
								<th scope="col">Requested changes</th>
								<th scope="col">Last active</th>
							</tr>
						</thead>
						<tbody>
							{reviewers.map((reviewer) => (
								<tr key={reviewer.name}>
									<th scope="row">
										<Icon name={reviewer.hosted ? "bot" : "shield"} size={14} className={MARK} /> {reviewer.name}
									</th>
									<td>{reviewer.roles.join(", ")}</td>
									<td className={reviewer.approvals ? "text-good" : undefined}>{reviewer.approvals}</td>
									<td className={reviewer.rejections ? "text-bad" : undefined}>{reviewer.rejections}</td>
									<td className="text-muted-foreground">{reviewer.lastActive ? timeAgo(reviewer.lastActive) : "–"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className={NONE}>No reviews yet.</p>
			)}
		</AgentsSection>
	);
}

/** A repo's agents, from the claims in force and the recent votes, and GitHive's hosted agents on it. */
export function AgentsTab({
	repo,
	snapshot,
	hosted,
}: {
	repo: string;
	snapshot: RepoSnapshot;
	hosted?: HostedAgentsApi;
}) {
	return (
		<div className="grid min-w-0 gap-4">
			<p className="m-0 text-muted-foreground">
				Repos keep no list of agents: these come from the claims in force and the latest votes.
			</p>
			<Authors authors={authorStats(snapshot)} />
			<Reviewers reviewers={reviewerStats(snapshot)} />
			{hosted ? <HostedAgents repo={repo} api={hosted} /> : null}
		</div>
	);
}
