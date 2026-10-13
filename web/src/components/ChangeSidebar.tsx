import type { ReactNode } from "react";
import type { ChangeHistory, RepoSnapshot } from "../api";
import { identityName } from "../lib/agent";
import type { Tone } from "../lib/changeStatus";
import type { Claim } from "../lib/claimStatus";
import { leaseWords } from "../lib/lease";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { TONE_TEXT, TonePill } from "./StatusPill";

/** The change as recorded: its claim while in force, or the claim from its history. */
export type ChangeRecord = Claim | NonNullable<ChangeHistory["claim"]>;
type Vote = RepoSnapshot["votes"][number];
type HostedReviewer = NonNullable<Claim["hosted"]>["reviewers"][number];

function verdictTone(verdict: HostedReviewer["verdict"]): Tone {
	if (verdict === "approve") return "good";
	if (verdict === "reject") return "bad";
	return "neutral";
}

const reviewCount = (count: number) => (count ? counted(count, "review") : "No reviews yet.");

/** A part of the sidebar, ruled off from the next. */
function Section({ title, children }: { title?: string; children: ReactNode }) {
	return (
		<section className="min-w-0 border-b border-border py-3.5 first:pt-0 last:border-b-0">
			{title ? <h2 className="mb-2 text-caption font-semibold text-muted-foreground">{title}</h2> : null}
			{children}
		</section>
	);
}

/** A list of reviewers or paths, a line each. */
const LIST = "m-0 grid list-none gap-1.5 p-0";
/** A small line under a section's own. */
const SMALL = "mt-1 mb-0 text-meta wrap-anywhere";

/** The change's details beside the conversation: reviewers, agent, claimed paths, and who blocks it. */
export function ChangeSidebar({
	snapshot,
	claim,
	record,
	agent,
	votes,
	now,
}: {
	snapshot: RepoSnapshot;
	claim: Claim | undefined;
	record: ChangeRecord | undefined;
	agent: string;
	votes: Vote[];
	/** The time a lease is told against (tests fix it). */
	now?: number;
}) {
	const builder = claim?.hosted?.builder;
	const lease = leaseWords(claim?.lease, now);
	return (
		<aside
			className="grid min-w-0 content-start gap-0 to-900:border-t to-900:border-border to-900:pt-4"
			aria-label="Change details"
		>
			<Section title="Reviewers">
				{claim?.hosted?.reviewers.length ? (
					<ul className={LIST}>
						{claim.hosted.reviewers.map((reviewer) => (
							<li key={reviewer.role} className="flex min-w-0 items-center justify-between gap-2">
								<span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
									<Icon name="shield" size={14} className="text-muted-foreground" />
									{reviewer.role}
								</span>
								<span
									className={cn(
										"inline-flex items-center gap-1 text-meta whitespace-nowrap transition-colors duration-base",
										TONE_TEXT[verdictTone(reviewer.verdict)],
									)}
								>
									{reviewer.verdict ?? reviewer.status}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="m-0 text-muted-foreground">{reviewCount(votes.length)}</p>
				)}
				<p className="mt-2 mb-0 text-meta text-muted-foreground">
					{claim?.trusted
						? "No review: GitHub's changes are trusted"
						: `${snapshot.policy.required} approvals required`}
				</p>
			</Section>
			<Section title="Agent">
				<p className="m-0 flex items-center gap-1.5 wrap-anywhere">
					<Icon name={builder ? "bot" : "user"} size={14} className="text-muted-foreground" />
					<strong>{agent}</strong>
					{record?.by && identityName(record.by) !== agent ? (
						<span className="text-muted-foreground"> · {identityName(record.by)}</span>
					) : null}
				</p>
				{builder ? (
					<p className={cn(SMALL, builder.status === "failed" ? "text-bad" : "text-neutral")}>
						Builder {builder.status}
						{builder.revisions ? ` (revision ${builder.revisions})` : ""}
						{builder.error ? `: ${builder.error}` : ""}
					</p>
				) : null}
				{claim ? <p className={cn(SMALL, "text-muted-foreground")}>Last active {timeAgo(claim.active)}</p> : null}
			</Section>
			<Section title="Claim">
				{record?.paths.length ? (
					<ul className={LIST}>
						{record.paths.map((path) => (
							<li key={path} className="flex min-w-0 items-center gap-1.5">
								<Icon name="folder" size={13} className="text-muted-foreground" />
								<code>{path}</code>
							</li>
						))}
					</ul>
				) : (
					<p className="m-0 text-muted-foreground">Released.</p>
				)}
				{lease ? (
					<p className={cn(SMALL, "mt-2 flex items-start gap-1.5", lease.free ? "text-warn" : "text-muted-foreground")}>
						<Icon name="clock" size={13} className="mt-0.5 shrink-0" />
						{lease.long}
					</p>
				) : null}
			</Section>
			{claim?.approval.vetoedBy.length ? (
				<Section>
					<TonePill tone="bad" icon="x">
						Blocked by {claim.approval.vetoedBy.join(", ")}
					</TonePill>
				</Section>
			) : null}
		</aside>
	);
}
