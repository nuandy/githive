import { messageOf } from "../lib/errors";
import "./Overview.css";
import { useState } from "react";
import type { RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { usePoll } from "../hooks/usePoll";
import { Territory } from "./Territory";
import { LAMP_WORDS, lampColor, lampCounts, LAMPS } from "../lib/overview";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";

/**
 * What the overview reads: the repo's files and, when the server reports it, what's landing. People who can
 * write can also make a branch.
 */
export interface OverviewApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	landing?(repo: string, branch: string): Promise<RepoLanding>;
	makeBranch?(repo: string, name: string, from: string): Promise<{ name: string; made?: string }>;
}

export interface OverviewProps {
	repo: string;
	/** The project's branch. */
	branch: string;
	/** The branch shown, when not the project's (from the address). */
	shown?: string;
	snapshot: RepoSnapshot;
	api: OverviewApi;
	/** May make branches (write). */
	canWrite?: boolean;
	/** After a branch is made: read the snapshot again. */
	onBranchMade?: () => void;
}

/** Which branch the overview shows, and making another (for people who can write). */
function BranchBar({
	repo,
	branch,
	shown,
	snapshot,
	api,
	canWrite,
	onBranchMade,
}: {
	repo: string;
	branch: string;
	shown: string;
	snapshot: RepoSnapshot;
	api: OverviewApi;
	canWrite: boolean;
	onBranchMade?: () => void;
}) {
	const names = [
		branch,
		...(snapshot.branches ?? [])
			.map((known) => known.name)
			.filter((other) => other !== branch)
			.sort(),
	];
	const [making, setMaking] = useState(false);
	const showBranch = (to: string) => {
		window.location.hash = href.repo(repo, "changes", to === branch ? undefined : to);
	};
	return (
		<div className="branch-bar">
			<label className="branch-bar__pick">
				<span>Branch</span>
				<select id="overview-branch" value={shown} onChange={(event) => showBranch(event.target.value)}>
					{names.map((branchName) => (
						<option key={branchName} value={branchName}>
							{branchName}
							{branchName === branch ? " (project)" : ""}
						</option>
					))}
				</select>
			</label>
			{canWrite && api.makeBranch && !making ? (
				<button type="button" onClick={() => setMaking(true)}>
					New branch
				</button>
			) : null}
			{making && api.makeBranch ? (
				<NewBranchForm
					names={names}
					shown={shown}
					make={(name, from) => api.makeBranch!(repo, name, from)}
					onMade={(made) => {
						setMaking(false);
						onBranchMade?.();
						showBranch(made);
					}}
					onCancel={() => setMaking(false)}
				/>
			) : null}
		</div>
	);
}

/** Names a new branch and what it starts from, and makes it. */
function NewBranchForm(props: {
	names: string[];
	shown: string;
	make: (name: string, from: string) => Promise<{ name: string }>;
	onMade: (name: string) => void;
	onCancel: () => void;
}) {
	const { names, shown, make, onMade, onCancel } = props;
	const [name, setName] = useState("");
	const [from, setFrom] = useState(shown);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const made = await make(name.trim(), from);
			setName("");
			onMade(made.name);
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<form className="branch-bar__new" onSubmit={submit}>
				<label className="sr-only" htmlFor="new-branch-name">
					Name of the new branch
				</label>
				<input
					id="new-branch-name"
					placeholder="feature/checkout"
					value={name}
					onChange={(event) => setName(event.target.value)}
					autoFocus
				/>
				<label htmlFor="new-branch-from">from</label>
				<select id="new-branch-from" value={from} onChange={(event) => setFrom(event.target.value)}>
					{names.map((branchName) => (
						<option key={branchName} value={branchName}>
							{branchName}
						</option>
					))}
				</select>
				<button type="submit" className="accent" disabled={busy || !name.trim()}>
					{busy ? "Making…" : "Make branch"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy}>
					Cancel
				</button>
			</form>
			{error ? (
				<p className="error branch-bar__error" role="alert">
					{error}
				</p>
			) : null}
		</>
	);
}

/** How each outcome lights. */

/** The claims in force, in a sentence: how many, and where their changes are. */
function Summary({ snapshot, landing }: { snapshot: RepoSnapshot; landing?: RepoLanding }) {
	const total = snapshot.claims.length;
	if (!total)
		return (
			<p className="overview__summary">
				No claims in force. When an agent claims part of the tree, it lights up below.
			</p>
		);
	const counts = lampCounts(snapshot.claims, { landing, votes: snapshot.votes });
	const parts = LAMPS.filter((lamp) => counts[lamp]).map((lamp) => (
		<span key={lamp} className={`overview__count lamp--${lampColor(lamp)}`}>
			<span className="lamp" aria-hidden="true" />
			{counts[lamp]} {lamp === "attention" && counts[lamp] > 1 ? "need a person" : LAMP_WORDS[lamp]}
		</span>
	));
	return (
		<p className="overview__summary">
			<strong>
				{total} {total === 1 ? "claim" : "claims"} in force
			</strong>
			{parts}
		</p>
	);
}

/**
 * A repo at a glance, on one of its branches: the claims on it in a sentence and
 * its territory. What's landing and who works where are on the Hive tab.
 */
export function Overview({ repo, branch, shown: asked, snapshot, api, canWrite = false, onBranchMade }: OverviewProps) {
	const known =
		asked === undefined || asked === branch || (snapshot.branches ?? []).some((other) => other.name === asked);
	const shown = asked && known ? asked : branch;
	const otherBranch = shown === branch ? undefined : shown;
	const landing = usePoll(api.landing ? `landing:${repo}:${shown}` : null, () => api.landing!(repo, shown), 5_000);
	const tree = usePoll(`tree:${repo}:${shown}`, () => api.tree(repo, otherBranch), 60_000);
	// Only the claims on this branch, since each change lands on one branch.
	const onBranch = { ...snapshot, claims: snapshot.claims.filter((claim) => (claim.into ?? branch) === shown) };
	const manyBranches = (snapshot.branches ?? []).length > 0 || canWrite;
	return (
		<div className="overview">
			{manyBranches ? (
				<BranchBar
					repo={repo}
					branch={branch}
					shown={shown}
					snapshot={snapshot}
					api={api}
					canWrite={canWrite}
					onBranchMade={onBranchMade}
				/>
			) : null}
			{!known ? (
				<p className="callout callout--warn">
					There's no branch {asked} taking changes here: showing {branch}.
				</p>
			) : null}
			<Summary snapshot={onBranch} landing={landing.data} />
			<Territory
				repo={repo}
				branch={shown}
				snapshot={onBranch}
				tree={tree.data}
				error={tree.error}
				landing={landing.data}
			/>
		</div>
	);
}
