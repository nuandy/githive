import { useState } from "react";
import type { RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import {
	claimedElsewhere,
	claimedFiles,
	claimsOnOtherBranches,
	heldIn,
	holderOf,
	holdersFromSnapshot,
	holdsInside,
	stateCounts,
	type ClaimHolder,
} from "../lib/claimsMap";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { STATES, type StateLook } from "../lib/status";
import { buildTree, type TreeNode } from "../lib/tree";
import { cn } from "../lib/utils";
import type { CodeApi } from "./CodeBrowser";
import { Icon } from "./Icon";
import { StateMark } from "./StateMark";
import { Box, BoxHeader } from "./ui/box";

// The one map of who holds what: a branch's files, each claimed one in its change's state (its color, pattern and
// glyph, as everywhere), named by who holds it and for what, and linked to its change. It shows only what's claimed
// until asked for every file.

export interface ClaimsMapProps {
	branch: string;
	holders: ClaimHolder[];
	tree?: RepoTree;
	treeError?: string;
	/** Open changes landing on other branches, which this map leaves out: how many, and where they're listed. */
	otherBranches?: { branch: string; count: number; href: string }[];
	/** Every file from the start, not only what's claimed. */
	allFiles?: boolean;
}

/** Each state's color as --claim, for the row it marks (status.ts names the color). */
const CLAIM: Record<StateLook["color"], string> = {
	"stage-building": "[--claim:var(--stage-building)]",
	"stage-review": "[--claim:var(--stage-review)]",
	"stage-landing": "[--claim:var(--stage-landing)]",
	"stage-landed": "[--claim:var(--stage-landed)]",
	good: "[--claim:var(--good)]",
	bad: "[--claim:var(--bad)]",
	neutral: "[--claim:var(--neutral)]",
};

/** A row of the tree: its state's mark, an icon, its name in the mono face, with room on its left for a rule. */
const ROW =
	"flex min-w-0 flex-wrap items-center gap-x-1.5 rounded-md border-l-3 border-transparent px-2 py-0.75 text-meta text-foreground";

/** Its state's mark, or the room for one where nothing's held, so the names keep in line. */
function Mark({ holder }: { holder: ClaimHolder | undefined }) {
	return <StateMark state={holder?.state} empty="invisible border-transparent" className="size-3.5 rounded-xs" />;
}

/**
 * A row a change holds, tinted with its state's color and ruled down its side. A link's tint deepens under the
 * pointer: a layer of the color fading in behind it (a color-mix() doesn't transition cleanly).
 */
function held(holder: ClaimHolder, link = false) {
	return cn(
		"border-l-(--claim) bg-[color-mix(in_srgb,var(--claim)_10%,transparent)]",
		CLAIM[STATES[holder.state].color],
		link &&
			cn(
				"relative isolate hover:no-underline",
				"before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-(--claim) before:opacity-0",
				"before:transition-opacity before:duration-fast hover:before:opacity-[0.12]",
			),
	);
}

/** Who holds a row and for what, at its right; under its name in a narrow window. */
const WHO = "ml-auto min-w-0 truncate pl-3 font-sans text-meta text-muted-foreground to-560:basis-full to-560:pl-5";

/** What a claimed row says to whoever can't see its mark. */
const said = (holder: ClaimHolder) => `, ${STATES[holder.state].short}, held by ${holder.agent} for ${holder.title}`;

/** Lists in the tree: a folder's entries, indented under it. */
const TREE = "m-0 list-none py-0 pr-0 pl-4.5";
/** The tree's top, inside its box. */
const ROOT = "m-0 list-none px-1 py-2";

interface NodeProps {
	node: TreeNode;
	holders: ClaimHolder[];
	files: string[];
	depth: number;
	/** Every folder open: only what's claimed is shown. */
	open: boolean;
	/** Who holds the folder it's in, so a row held by the same change doesn't say so again. */
	within?: ClaimHolder;
}

function Node(props: NodeProps) {
	return props.node.kind === "file" ? <FileNode {...props} /> : <FolderNode {...props} />;
}

function FileNode({ node, holders, within }: NodeProps) {
	const holder = holderOf(node.path, holders);
	const conflict = holder?.conflicts.includes(node.path);
	const content = (
		<>
			<Mark holder={holder} />
			<Icon name="file" size={14} className="text-muted-foreground" />
			<span className="min-w-0 font-mono wrap-anywhere">{node.name}</span>
			{conflict ? (
				<span className="inline-flex text-warn" title="Open changes conflict in this file">
					<Icon name="conflict" size={14} label="conflict" />
				</span>
			) : null}
			{holder && holder.change !== within?.change ? (
				<span className={WHO} aria-hidden="true">
					{holder.agent} · {holder.title}
				</span>
			) : null}
			{holder ? <span className="sr-only">{said(holder)}</span> : null}
		</>
	);
	return (
		<li>
			{holder ? (
				<a href={holder.href} className={cn(ROW, held(holder, true))}>
					{content}
				</a>
			) : (
				<span className={ROW}>{content}</span>
			)}
		</li>
	);
}

function FolderNode({ node, holders, files, depth, open: allOpen, within }: NodeProps) {
	const holder = holderOf(node.path, holders);
	// At the top level, a folder with few entries opens too.
	const open = allOpen || holdsInside(node.path, holders) || (depth === 0 && node.children.length < 12);
	const count = holder ? 0 : heldIn(node.path, files, holders);
	const named = holder && holder.change !== within?.change;
	return (
		<li className="relative">
			<details open={open} className="disclosure">
				<summary
					className={cn(
						ROW,
						"cursor-pointer list-none [&::-webkit-details-marker]:hidden",
						holder && held(holder),
						named && "pr-[42%]",
					)}
				>
					<Mark holder={holder} />
					{/* Points down open, at the folder's name folded. */}
					<Icon
						name="chevron"
						size={14}
						className="text-muted-foreground transition-transform duration-fast ease-out [details:not([open])>summary>&]:-rotate-90"
					/>
					<Icon name="folder" size={14} className="text-link" />
					<span className="min-w-0 font-mono wrap-anywhere">{node.name}</span>
					{count ? <span className="pl-1.5 font-sans text-meta text-muted-foreground">{count} held</span> : null}
					{holder ? <span className="sr-only">{said(holder)}</span> : null}
				</summary>
				<ul className={TREE}>
					{node.children.map((child) => (
						<Node
							key={child.path}
							node={child}
							holders={holders}
							files={files}
							depth={depth + 1}
							open={allOpen}
							within={holder ?? within}
						/>
					))}
				</ul>
			</details>
			{/* The folder's holder, at the right of its row: a link of its own beside the row that opens it. */}
			{named ? (
				<a
					href={holder.href}
					className="absolute top-0 right-2 max-w-[40%] truncate py-0.75 text-meta leading-[inherit] text-muted-foreground hover:text-link"
				>
					{holder.agent} · {holder.title}
				</a>
			) : null}
		</li>
	);
}

/** A line in a box: a note, or why the tree isn't shown. */
const ROW_NOTE = "m-0 px-0.5 py-3";

/**
 * The files on the branch with their holders (only those held, unless `all`), or why they aren't shown. Once they
 * load, they fade in.
 */
function FileTree({
	branch,
	holders,
	tree,
	treeError,
	all,
}: Pick<ClaimsMapProps, "branch" | "holders" | "tree" | "treeError"> & { all: boolean }) {
	const phase = tree ? "tree" : treeError ? "error" : "loading";
	const fades = useChanged(phase) && "animate-fade";
	if (treeError) {
		return (
			<p className={cn(ROW_NOTE, "text-bad", fades)} role="alert">
				Couldn't list the files: {treeError}
			</p>
		);
	}
	if (!tree) {
		return (
			<p className={cn(ROW_NOTE, "text-muted-foreground")} role="status">
				Loading files…
			</p>
		);
	}
	if (tree.files.length === 0)
		return <p className={cn(ROW_NOTE, "text-muted-foreground", fades)}>{branch} has no files yet.</p>;
	const files = all ? tree.files : claimedFiles(tree.files, holders);
	if (!files.length)
		return (
			<p className={cn(ROW_NOTE, "text-muted-foreground", fades)}>
				No open change holds a file on {branch} right now: every path is free.
			</p>
		);
	return (
		<ul className={cn(ROOT, fades)}>
			{buildTree(files).map((node) => (
				<Node key={node.path} node={node} holders={holders} files={tree.files} depth={0} open={!all} />
			))}
		</ul>
	);
}

/** What the marks mean: each state some change is in, with how many are. */
function Key({ holders }: { holders: ClaimHolder[] }) {
	const counts = stateCounts(holders);
	if (!counts.length) return null;
	return (
		<ul
			className="m-0 flex list-none flex-wrap gap-x-4.5 gap-y-1.5 border-b border-border px-0.5 py-2.5 text-ui text-muted-foreground"
			aria-label="Open changes by state"
		>
			{counts.map(([state, count]) => (
				<li key={state} className="inline-flex items-center gap-1.75">
					<StateMark state={state} className="size-3.5 rounded-xs" />
					{count} {STATES[state].short}
				</li>
			))}
		</ul>
	);
}

/** Which open change holds which part of a branch, over its file tree. */
export function ClaimsMap({ branch, holders, tree, treeError, otherBranches = [], allFiles = false }: ClaimsMapProps) {
	const [all, setAll] = useState(allFiles);
	const elsewhere = tree ? claimedElsewhere(tree.files, holders) : [];
	// What comes with the files, once they load, fades in with them.
	const loaded = useChanged(!!tree) && "animate-fade";
	const heldFiles = tree ? claimedFiles(tree.files, holders).length : 0;
	return (
		<div className="grid min-w-0 gap-4">
			<Box aria-labelledby="claims-tree-title">
				<BoxHeader>
					<h2 id="claims-tree-title" className="text-body-sm">
						Who holds what on {branch}
					</h2>
					{tree ? (
						<span className={cn("font-normal text-muted-foreground", loaded)}>
							{counted(holders.length, "open change")} hold {heldFiles} of {counted(tree.files.length, "file")}
						</span>
					) : null}
					<label className="ml-auto inline-flex items-center gap-2 text-ui font-normal">
						<input type="checkbox" checked={!all} onChange={(event) => setAll(!event.target.checked)} />
						Only claimed
					</label>
				</BoxHeader>
				<Key holders={holders} />
				<FileTree branch={branch} holders={holders} tree={tree} treeError={treeError} all={all} />
				{tree?.truncated ? (
					<p className={cn(ROW_NOTE, "border-t border-border text-muted-foreground")}>
						This repo is very large: only part of its file list is shown, so some claims may not appear.
					</p>
				) : null}
				{otherBranches.length ? (
					<p className={cn(ROW_NOTE, "border-t border-border text-ui text-muted-foreground")}>
						{otherBranches.map((other, index) => (
							<span key={other.branch}>
								{index ? "; " : ""}
								{counted(other.count, "open change")} {other.count === 1 ? "lands" : "land"} on{" "}
								<a href={other.href}>
									<code>{other.branch}</code>
								</a>
							</span>
						))}
						, and {otherBranches.length === 1 && otherBranches[0]!.count === 1 ? "holds" : "hold"} paths there, not
						here.
					</p>
				) : null}
			</Box>

			{elsewhere.length ? (
				<Box aria-labelledby="claims-new-title" className={cn(loaded)}>
					<BoxHeader>
						<h2 id="claims-new-title" className="text-body-sm">
							Claimed, not on {branch} yet
						</h2>
					</BoxHeader>
					<ul className={ROOT}>
						{elsewhere.map(({ path, holder }) => (
							<li key={`${holder.change}:${path}`}>
								<a href={holder.href} className={cn(ROW, held(holder, true))}>
									<Mark holder={holder} />
									<Icon name={path.endsWith("/") ? "folder" : "file"} size={14} className="text-muted-foreground" />
									<span className="min-w-0 font-mono wrap-anywhere">{path}</span>
									<span className={WHO} aria-hidden="true">
										{holder.agent} · {holder.title}
									</span>
									<span className="sr-only">{said(holder)}</span>
								</a>
							</li>
						))}
					</ul>
				</Box>
			) : null}
		</div>
	);
}

/** The Claims tab with its loading: the project's branch's files, and what's being checked to land on it. */
export function ClaimsTab({
	repo,
	branch,
	snapshot,
	api,
}: {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	api: Pick<CodeApi, "tree"> & { landing?: (repo: string, branch: string) => Promise<RepoLanding> };
}) {
	const tree = usePoll(`tree:${repo}:${branch}`, () => api.tree(repo, branch), 60_000);
	const landing = usePoll(api.landing ? `landing:${repo}:${branch}` : null, () => api.landing!(repo, branch), 10_000);
	const holders = holdersFromSnapshot(snapshot, repo, { branch, landing: landing.data });
	const otherBranches = claimsOnOtherBranches(snapshot, branch).map((other) => ({
		...other,
		href: href.changes(repo, { branch: other.branch }),
	}));
	return (
		<ClaimsMap
			branch={branch}
			holders={holders}
			tree={tree.data}
			treeError={tree.data ? undefined : tree.error}
			otherBranches={otherBranches}
		/>
	);
}
