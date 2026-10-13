import { type ReactNode, useState } from "react";
import type { ReleaseAnswer } from "../api";
import type { ChangeStatus } from "../lib/changeStatus";
import type { changeEnding } from "../lib/changeTimeline";
import {
	type Batch,
	type CheckResult,
	type ConflictState,
	type PrimaryAction,
	type Reader,
	type RoleLine,
	roleSaying,
	voterName,
} from "../lib/decision";
import { shortSha } from "../lib/model";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { LandNow, type MergeAnswer, type Outcome, OutcomeLine, ReleaseDialog } from "./ChangeActions";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusPill";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

// The decision box on a change's page: where it stands and what deciding on it needs, in one place. Approvals per
// role and who gave each, the latest check on its head, whether it conflicts with its branch, how many open changes its
// code meets, and one thing to do next: land it, or vote. Its ⋯ menu releases the claim. Sticky in the sidebar on a wide
// window, under the page's header on a narrow one; the page scrolls to it and focuses it when asked to decide.

export type ChangeEnding = NonNullable<ReturnType<typeof changeEnding>>;

/** Where the box's links go on the page. */
export type PageTarget = "vote" | "conflict" | "awareness";

export interface DecisionBoxProps {
	repo: string;
	changeId: string;
	status: ChangeStatus | null;
	/** What it waits on in a line, in place of its state's sentence (an agent's question, said in full above). */
	summary?: string | undefined;
	/** The claim while in force; how it ended once it isn't. */
	inForce: boolean;
	ending: ChangeEnding | null;
	branch: string;
	roles: RoleLine[];
	/** Why GitHub's change needs no review, while the repo trusts it. */
	trusted?: string | undefined;
	reader: Reader;
	check: CheckResult;
	/** The checks that run before it lands. */
	checks: string[];
	conflict: ConflictState | null;
	/** How many open changes its code meets; null when its footprint isn't known. */
	meets: number | null;
	action: PrimaryAction;
	/** The other changes that would land with it. */
	batch: Batch;
	land?: (() => Promise<MergeAnswer>) | undefined;
	release?: ((reason: string) => Promise<ReleaseAnswer>) | undefined;
	/** GitHub's change: releasing it gives it up until GitHub's branch moves. */
	github?: boolean;
	onGo: (target: PageTarget) => void;
	className?: string;
}

/** A line of the box: what it's about, in small capitals' place, then what's so. */
function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-w-0 gap-1">
			<dt className="text-caption font-semibold text-muted-foreground">{label}</dt>
			<dd className="m-0 min-w-0 text-ui wrap-anywhere">{children}</dd>
		</div>
	);
}

/** A link that stays on the page: it goes to a part of it rather than to an address. */
function GoTo({ onClick, children }: { onClick: () => void; children: ReactNode }) {
	return (
		<Button variant="link" className="p-0 text-ui" onClick={onClick}>
			{children}
		</Button>
	);
}

/** "review: 1 of 2 · robin/reviewer", "security: githive-guard ✓". */
function Approvals({ roles, reader, trusted }: { roles: RoleLine[]; reader: Reader; trusted?: string | undefined }) {
	if (!roles.length) return <>{trusted ? "No review: GitHub's changes are trusted." : "No review needed."}</>;
	return (
		<ul className="m-0 grid list-none gap-1 p-0">
			{roles.map((line) => {
				const { text, mark } = roleSaying(line, reader);
				return (
					<li key={line.role} className="min-w-0">
						<span className="font-semibold">{line.role}:</span> {text}
						{mark ? <span className={cn("ml-1", mark === "✓" ? "text-good" : "text-bad")}>{mark}</span> : null}
					</li>
				);
			})}
		</ul>
	);
}

/** The latest check on the head, with what it found, or that checks come after approval. */
function Check({ check, checks, approved }: { check: CheckResult; checks: string[]; approved: boolean }) {
	if (check.kind === "running")
		return (
			<span className="inline-flex items-start gap-1.5">
				<Icon name="clock" size={14} className="mt-0.75 shrink-0 text-warn" />
				<span>
					Being checked to land, with its batch, since {timeAgo(check.since)}
					{checks.length ? <>: {checks.join(", ")}</> : null}.
				</span>
			</span>
		);
	if (check.kind === "passed")
		return (
			<span className="inline-flex items-start gap-1.5">
				<Icon name="check" size={14} className="mt-0.75 shrink-0 text-good" />
				Passed {timeAgo(check.at)}.
			</span>
		);
	if (check.kind === "failed") {
		const [first, ...rest] = check.evidence.trim().split("\n");
		return (
			<div className="grid gap-1">
				<span className="inline-flex items-start gap-1.5 text-bad">
					<Icon name="x" size={14} className="mt-0.75 shrink-0" />
					<span>
						Failed {timeAgo(check.at)}: <span className="text-foreground">{first}</span>
					</span>
				</span>
				{rest.length ? (
					<details className="disclosure">
						<summary className="cursor-pointer text-meta text-muted-foreground">What it said</summary>
						<pre tabIndex={0} className="mt-1 max-h-60 text-caption leading-[1.45] whitespace-pre-wrap">
							<code>{rest.join("\n")}</code>
						</pre>
					</details>
				) : null}
			</div>
		);
	}
	if (!checks.length) return <>No checks: it lands once approved.</>;
	return (
		<>{approved ? `They run as it lands: ${checks.join(", ")}.` : `Checks run after approval: ${checks.join(", ")}.`}</>
	);
}

/** Whether it conflicts with its branch, as its last merge check found on its head. */
function Conflict({ conflict, onGo }: { conflict: ConflictState; onGo: (target: PageTarget) => void }) {
	if (conflict.kind === "conflicts")
		return (
			<span className="inline-flex flex-wrap items-baseline gap-x-1.5 text-bad">
				<Icon name="conflict" size={14} className="self-center" />
				Conflicts with {conflict.into} in {counted(conflict.files.length, "file")}.
				<GoTo onClick={() => onGo("conflict")}>See the conflict</GoTo>
			</span>
		);
	if (conflict.kind === "clean")
		return (
			<span className="inline-flex items-center gap-1.5">
				<Icon name="check" size={14} className="text-good" />
				No conflict with {conflict.into}.
			</span>
		);
	return <span className="text-muted-foreground">Not checked against its latest push yet.</span>;
}

/** How it ended: landed, with the commit, or released, by whom and why. */
function Ended({
	ending,
	branch,
	repo,
	reader,
}: {
	ending: ChangeEnding;
	branch: string;
	repo: string;
	reader: Reader;
}) {
	const { release } = ending;
	if (ending.kind === "merged")
		return (
			<p className="m-0 text-ui">
				Landed on {branch} as{" "}
				<a href={href.code(repo, "", release.mergedAs)}>
					<code>{shortSha(release.mergedAs)}</code>
				</a>
				, {timeAgo(release.at)}.
			</p>
		);
	const who = release.by && release.by !== release.agent ? voterName(release.by, reader) : release.agent;
	const why = release.stale ? "its agent had gone quiet." : release.reason || "its paths are free again.";
	return (
		<p className="m-0 text-ui wrap-anywhere">
			Released by {who}: {why} <span className="text-muted-foreground">{timeAgo(release.at)}</span>
		</p>
	);
}

/** The box. */
export function DecisionBox(props: DecisionBoxProps) {
	const { repo, changeId, status, inForce, ending, branch, reader, action, release, onGo, className } = props;
	const [releasing, setReleasing] = useState(false);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const menu = inForce && release;
	return (
		<section
			id="decide"
			tabIndex={-1}
			aria-labelledby="decide-title"
			className={cn(
				"min-w-0 scroll-mt-[calc(var(--topbar-height)+12px)] rounded-md border border-border bg-card",
				className,
			)}
		>
			<div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
				<h2 id="decide-title" className="sr-only">
					Deciding on it
				</h2>
				{status ? <StatusPill status={status} size="lg" solid /> : <span />}
				{menu ? (
					<>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon" aria-label="More about this change">
									<Icon name="more" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => setReleasing(true)}>
									<Icon name="ban" size={14} />
									Release claim…
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<ReleaseDialog
							change={changeId}
							github={!!props.github}
							open={releasing}
							onOpenChange={setReleasing}
							release={release}
							onOutcome={setOutcome}
						/>
					</>
				) : null}
			</div>
			<div className="grid gap-3 px-3.5 pt-2.5 pb-3.5">
				{ending && !inForce ? (
					<Ended ending={ending} branch={branch} repo={repo} reader={reader} />
				) : (
					<>
						{status ? <p className="m-0 text-ui text-muted-foreground">{props.summary ?? status.description}</p> : null}
						<dl className="m-0 grid gap-2.5">
							<Row label="Approvals">
								<Approvals roles={props.roles} reader={reader} trusted={props.trusted} />
							</Row>
							<Row label="Checks">
								<Check check={props.check} checks={props.checks} approved={status?.kind === "approved"} />
							</Row>
							{props.conflict ? (
								<Row label={`Against ${props.conflict.into}`}>
									<Conflict conflict={props.conflict} onGo={onGo} />
								</Row>
							) : null}
							{props.meets !== null ? (
								<Row label="Awareness">
									{props.meets ? (
										<GoTo onClick={() => onGo("awareness")}>Meets {counted(props.meets, "other open change")}</GoTo>
									) : (
										"Meets no other open change."
									)}
								</Row>
							) : null}
						</dl>
						{action === "land" && props.land ? (
							<LandNow
								change={changeId}
								batch={props.batch}
								checks={props.checks}
								land={props.land}
								onOutcome={setOutcome}
							/>
						) : null}
						{action === "vote" ? (
							<Button variant="primary" className="w-full" onClick={() => onGo("vote")}>
								Vote
							</Button>
						) : null}
					</>
				)}
				<OutcomeLine outcome={outcome} />
			</div>
		</section>
	);
}
