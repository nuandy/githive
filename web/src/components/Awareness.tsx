import type { ChangeAwareness, Overlap, RepoSnapshot } from "../api";
import { ALTERED_BY, ALTERING, openOverlaps, siteName, SITES_SHOWN } from "../lib/awareness";
import { shortSha } from "../lib/model";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { Icon } from "./Icon";
import "./Awareness.css";

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
		<div className="awareness__signatures">
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
				<span className="muted">
					{" "}
					· used here
					<Sites at={overlap.at} />
				</span>
			) : null}
			<Signatures overlap={overlap} />
		</li>
	);
}

/** The awareness section of a change's page, while its claim is in force and its footprint is kept. */
export function Awareness({
	awareness,
	claims,
	head,
	repo,
}: {
	awareness: ChangeAwareness;
	claims: RepoSnapshot["claims"];
	head?: string | null;
	repo: string;
}) {
	const usedBy = openOverlaps(awareness.usedBy, claims);
	const alteredBy = openOverlaps(awareness.alteredBy, claims);
	const left = (awareness.omitted?.usedBy ?? 0) + (awareness.omitted?.alteredBy ?? 0);
	// Footprints are read from pushes as the push consumer gets to them, so one may lag the change's head.
	const moved = !!head && head !== awareness.head;
	return (
		<section className="awareness" aria-labelledby="awareness-title">
			<div className="awareness__head">
				<Icon name="eye" size={15} className="muted" />
				<h2 id="awareness-title">Where it meets other open changes</h2>
			</div>
			<p className="muted awareness__about">
				From the code of the changes open on {awareness.branch}, read at <code>{shortSha(awareness.head)}</code>
				{moved ? " (before its latest push)" : ""}. Their agents hear the same in heads-ups; nothing here decides a
				merge.
			</p>
			{usedBy.length ? (
				<>
					<h3>What it alters that others use</h3>
					<ul className="awareness__lines">
						{usedBy.map((overlap, index) => (
							<UsedBy key={index} overlap={overlap} repo={repo} />
						))}
					</ul>
				</>
			) : null}
			{alteredBy.length ? (
				<>
					<h3>What it uses that others alter</h3>
					<ul className="awareness__lines">
						{alteredBy.map((overlap, index) => (
							<AlteredBy key={index} overlap={overlap} repo={repo} />
						))}
					</ul>
				</>
			) : null}
			{!usedBy.length && !alteredBy.length ? (
				<p className="awareness__none">
					Nothing it alters is used by another open change, and nothing it uses is being altered: it alters{" "}
					{counted(awareness.alters.length, "name")} and uses {counted(awareness.uses.length, "name")} of other files.
				</p>
			) : null}
			{left ? <p className="muted awareness__more">And {left} more not shown.</p> : null}
		</section>
	);
}
