import { messageOf } from "../lib/errors";
import { useState } from "react";
import type { RepoSnapshot } from "../api";
import { useChanged } from "../hooks/useChanged";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Input, Label, NativeSelect } from "./ui/field";

/** People who can write can make a branch. */
export interface OverviewApi {
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
	// The form and the button take each other's place, fading in; the button is there at once the first time.
	const swapped = useChanged(making);
	const showBranch = (to: string) => {
		window.location.hash = href.repo(repo, "changes", to === branch ? undefined : to);
	};
	return (
		<div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
			<Label className="inline-flex items-center gap-2">
				<span>Branch</span>
				<NativeSelect
					id="overview-branch"
					className="font-mono text-ui-lg"
					value={shown}
					onChange={(event) => showBranch(event.target.value)}
				>
					{names.map((branchName) => (
						<option key={branchName} value={branchName}>
							{branchName}
							{branchName === branch ? " (project)" : ""}
						</option>
					))}
				</NativeSelect>
			</Label>
			{canWrite && api.makeBranch && !making ? (
				<Button className={cn(swapped && "animate-fade")} onClick={() => setMaking(true)}>
					New branch
				</Button>
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
			<form className="flex animate-fade flex-wrap items-center gap-2" onSubmit={submit}>
				<label className="sr-only" htmlFor="new-branch-name">
					Name of the new branch
				</label>
				<Input
					id="new-branch-name"
					className="min-w-[12ch] font-mono text-ui-lg"
					placeholder="feature/checkout"
					value={name}
					onChange={(event) => setName(event.target.value)}
					autoFocus
				/>
				<label className="font-normal text-muted-foreground" htmlFor="new-branch-from">
					from
				</label>
				<NativeSelect
					id="new-branch-from"
					className="font-mono text-ui-lg"
					value={from}
					onChange={(event) => setFrom(event.target.value)}
				>
					{names.map((branchName) => (
						<option key={branchName} value={branchName}>
							{branchName}
						</option>
					))}
				</NativeSelect>
				<Button type="submit" variant="primary" disabled={busy || !name.trim()}>
					{busy ? "Making…" : "Make branch"}
				</Button>
				<Button onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			</form>
			{error ? (
				<p key={error} className="m-0 basis-full animate-appear text-bad" role="alert">
					{error}
				</p>
			) : null}
		</>
	);
}

/**
 * Which branch the Changes tab shows, and making another, for a repo with more than its project's branch (or people
 * who may make one); and a word when the address names a branch the repo hasn't. Who holds what is on the Claims tab,
 * what's landing and who works where on the Hive's.
 */
export function Overview({ repo, branch, shown: asked, snapshot, api, canWrite = false, onBranchMade }: OverviewProps) {
	const known =
		asked === undefined || asked === branch || (snapshot.branches ?? []).some((other) => other.name === asked);
	const shown = asked && known ? asked : branch;
	const manyBranches = (snapshot.branches ?? []).length > 0 || canWrite;
	if (!manyBranches && known) return null;
	return (
		<div className="mb-6 grid gap-4">
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
				<Callout tone="warn">
					There's no branch {asked} taking changes here: showing {branch}.
				</Callout>
			) : null}
		</div>
	);
}
