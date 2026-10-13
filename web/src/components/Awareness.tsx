import type { ChangeAwareness, Overlap, RepoSnapshot } from "../api";
import { ALTERED_BY, ALTERING, openOverlaps, siteName, SITES_SHOWN } from "../lib/awareness";
import { shortSha } from "../lib/model";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";

// Where a change meets other open changes, from their code: what it alters that they use, and what it uses that they
// alter. Their agents hear the same in heads-ups. Advice only: a merge doesn't read it.

/** "carol's c-3", linked to the other change, its intent on hover. */
function OtherChange({ other, repo }: { other: Overlap["other"]; repo: string }) {
	return (
		<>
			{other.by}'s{" "}
			<a href={href.change(repo, other.change)} title={other.intent}>
				{other.change}
			</a>
		</>
	);
}

/** "at `src/jobs/sync.ts:4`, `src/x.ts:9` and 2 more". */
function Sites({ at }: { at: Overlap["at"] }) {
	if (!at.length) return null;
	const shown = at.slice(0, SITES_SHOWN);
	return (
		<>
			{" at "}
			{shown.map((site, index) => (
				<span key={siteName(site)}>
					{index ? ", " : null}
					<code>{siteName(site)}</code>
				</span>
			))}
			{at.length > shown.length ? ` and ${at.length - shown.length} more` : null}
		</>
	);
}

/** An interface change's two signatures, for the reader to compare. */
function Signatures({ overlap }: { overlap: Overlap }) {
	const { before, after, change } = overlap.altered;
	if (change !== "interface" || !before || !after) return null;
	return (
		<div className="mt-0.75 text-caption text-muted-foreground [&_code]:text-micro">
			<code>{before}</code>
			<span aria-label="becomes"> → </span>
			<code>{after}</code>
		</div>
	);
}

/** "alters `loadSettings` (signature), used by carol's c-3 at `src/jobs/sync.ts:4`". */
function UsedBy({ overlap, repo }: { overlap: Overlap; repo: string }) {
	const { verb, aside } = ALTERING[overlap.altered.change];
	return (
		<li>
			{verb} <code>{overlap.altered.name}</code>
			{aside ? ` ${aside}` : null}, used by <OtherChange other={overlap.other} repo={repo} />
			<Sites at={overlap.at} />
			<Signatures overlap={overlap} />
		</li>
	);
}

/** "uses `Store.get`, which bob's c-9 removes", and where this change uses it. */
function AlteredBy({ overlap, repo }: { overlap: Overlap; repo: string }) {
	const { lead, verb } = ALTERED_BY[overlap.altered.change];
	return (
		<li>
			uses <code>{overlap.altered.name}</code>, {lead} <OtherChange other={overlap.other} repo={repo} /> {verb}
			{overlap.at.length ? (
				<span className="text-muted-foreground">
					{" "}
					· used here
					<Sites at={overlap.at} />
				</span>
			) : null}
			<Signatures overlap={overlap} />
		</li>
	);
}

const NOTE = "m-0 text-meta";
const HEADING = "mt-1 text-meta font-semibold text-muted-foreground";
const LINES = "m-0 grid list-disc gap-2 pl-4.5 text-ui-lg";

/**
 * The awareness section of a change's page, while its claim is in force and its footprint is kept. Beside the
 * conversation, like the merge box, quiet.
 */
export function Awareness({
	awareness,
	claims,
	head,
	repo,
	className,
}: {
	awareness: ChangeAwareness;
	claims: RepoSnapshot["claims"];
	head?: string | null;
	repo: string;
	className?: string;
}) {
	const usedBy = openOverlaps(awareness.usedBy, claims);
	const alteredBy = openOverlaps(awareness.alteredBy, claims);
	const left = (awareness.omitted?.usedBy ?? 0) + (awareness.omitted?.alteredBy ?? 0);
	// The names lists are capped: what was left out counts too.
	const alters = awareness.alters.length + (awareness.omitted?.alters ?? 0);
	const uses = awareness.uses.length + (awareness.omitted?.uses ?? 0);
	// Footprints are read from pushes as the push consumer gets to them, so one may lag the change's head.
	const moved = !!head && head !== awareness.head;
	return (
		<section
			className={cn(
				"grid min-w-0 gap-2 rounded-md border border-border bg-card px-4 pt-3 pb-3.5 wrap-anywhere",
				className,
			)}
			aria-labelledby="awareness-title"
		>
			<div className="flex items-center gap-2">
				<Icon name="eye" size={15} className="text-muted-foreground" />
				<h2 id="awareness-title" className="text-body-sm">
					Where it meets other open changes
				</h2>
			</div>
			<p className={cn(NOTE, "text-muted-foreground")}>
				From the code of the changes open on {awareness.branch}, read at <code>{shortSha(awareness.head)}</code>
				{moved ? " (before its latest push)" : ""}. Their agents hear the same in heads-ups; nothing here decides a
				merge.
			</p>
			{usedBy.length ? (
				<>
					<h3 className={HEADING}>What it alters that others use</h3>
					<ul className={LINES}>
						{usedBy.map((overlap, index) => (
							<UsedBy key={index} overlap={overlap} repo={repo} />
						))}
					</ul>
				</>
			) : null}
			{alteredBy.length ? (
				<>
					<h3 className={HEADING}>What it uses that others alter</h3>
					<ul className={LINES}>
						{alteredBy.map((overlap, index) => (
							<AlteredBy key={index} overlap={overlap} repo={repo} />
						))}
					</ul>
				</>
			) : null}
			{!usedBy.length && !alteredBy.length ? (
				<p className={NOTE}>
					Nothing it alters is used by another open change, and nothing it uses is being altered: it alters{" "}
					{counted(alters, "name")} and uses {counted(uses, "name")} of other files.
				</p>
			) : null}
			{left ? <p className={cn(NOTE, "text-muted-foreground")}>And {left} more not shown.</p> : null}
		</section>
	);
}
