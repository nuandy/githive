import type { RepoTree } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { claimedElsewhere, holderOf, holdsInside, type ClaimHolder } from "../lib/claimsMap";
import { buildTree, type TreeNode } from "../lib/tree";
import { cn } from "../lib/utils";
import type { CodeApi } from "./CodeBrowser";
import { Icon } from "./Icon";
import { Box, BoxHeader } from "./ui/box";

export interface ClaimsMapProps {
	branch: string;
	holders: ClaimHolder[];
	tree?: RepoTree;
	treeError?: string;
}

/** Each change's color (theme.css's --claim-N), as --claim for what it marks. */
const CLAIM = [
	"[--claim:var(--claim-0)]",
	"[--claim:var(--claim-1)]",
	"[--claim:var(--claim-2)]",
	"[--claim:var(--claim-3)]",
	"[--claim:var(--claim-4)]",
	"[--claim:var(--claim-5)]",
	"[--claim:var(--claim-6)]",
	"[--claim:var(--claim-7)]",
];

const claimColor = (holder: ClaimHolder) => CLAIM[holder.color % CLAIM.length];

function Swatch({ holder, className }: { holder: ClaimHolder; className?: string }) {
	return (
		<span
			className={cn("inline-block size-3 shrink-0 rounded-sm bg-(--claim)", claimColor(holder), className)}
			aria-hidden="true"
		/>
	);
}

/** A row of the tree: a file or folder, in the mono face, with room on its left for a claim's color. */
const ITEM =
	"flex min-w-0 items-center gap-1.5 rounded-md border-l-3 border-transparent px-2 py-0.75 font-mono text-meta text-foreground";

/**
 * A row a change holds, tinted with its color and ruled down its side. A link's tint deepens under the pointer: a
 * layer of the color fading in behind it (a color-mix() doesn't transition cleanly).
 */
function held(holder: ClaimHolder, link = false) {
	return cn(
		"border-l-(--claim) bg-[color-mix(in_srgb,var(--claim)_16%,transparent)]",
		claimColor(holder),
		link &&
			cn(
				"relative isolate hover:no-underline",
				"before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-(--claim) before:opacity-0",
				"before:transition-opacity before:duration-fast hover:before:opacity-[0.143]",
			),
	);
}

/** Lists in the tree: a folder's entries, indented under it. */
const TREE = "m-0 list-none py-0 pr-0 pl-4.5";
/** The tree's top, inside its box. */
const ROOT = "m-0 list-none px-3 py-2";

interface NodeProps {
	node: TreeNode;
	holders: ClaimHolder[];
	depth: number;
}

function Node(props: NodeProps) {
	return props.node.kind === "file" ? <FileNode {...props} /> : <FolderNode {...props} />;
}

function FileNode({ node, holders }: NodeProps) {
	const holder = holderOf(node.path, holders);
	const conflict = holder?.conflicts.includes(node.path);
	const content = (
		<>
			<Icon name="file" size={14} className="text-muted-foreground" />
			<span className="min-w-0 wrap-anywhere">{node.name}</span>
			{conflict ? (
				<span className="ml-auto inline-flex text-warn" title="Open changes conflict in this file">
					<Icon name="conflict" size={14} label="conflict" />
				</span>
			) : null}
		</>
	);
	return (
		<li>
			{holder ? (
				<a
					href={holder.href}
					className={cn(ITEM, held(holder, true))}
					aria-label={`${node.name}, claimed by ${holder.title}`}
					title={`${holder.title} · ${holder.agent}`}
				>
					{content}
				</a>
			) : (
				<span className={ITEM}>{content}</span>
			)}
		</li>
	);
}

function FolderNode({ node, holders, depth }: NodeProps) {
	const holder = holderOf(node.path, holders);
	// At the top level, a folder with few entries opens too.
	const open = holdsInside(node.path, holders) || (depth === 0 && node.children.length < 12);
	return (
		<li>
			<details open={open} className="disclosure">
				<summary
					className={cn(ITEM, "cursor-pointer list-none [&::-webkit-details-marker]:hidden", holder && held(holder))}
					title={holder ? `${holder.title} · ${holder.agent}` : undefined}
				>
					{/* Points down open, at the folder's name folded. */}
					<Icon
						name="chevron"
						size={14}
						className="text-muted-foreground transition-transform duration-fast ease-out [details:not([open])>summary>&]:-rotate-90"
					/>
					<Icon name="folder" size={14} className="text-link" />
					<span className="min-w-0 wrap-anywhere">{node.name}</span>
					{holder ? <span className="sr-only">, claimed by {holder.title}</span> : null}
				</summary>
				<ul className={TREE}>
					{node.children.map((child) => (
						<Node key={child.path} node={child} holders={holders} depth={depth + 1} />
					))}
				</ul>
			</details>
		</li>
	);
}

/** A line in a box under its header: a note, or why the tree isn't shown. */
const ROW = "my-3.75 px-0.5 py-3";

/** The files on the branch with their holders, or why they aren't shown. Once they load, they fade in. */
function FileTree({ branch, holders, tree, treeError }: ClaimsMapProps) {
	const phase = tree ? "tree" : treeError ? "error" : "loading";
	const fades = useChanged(phase) && "animate-fade";
	if (treeError) {
		return (
			<p className={cn(ROW, "text-bad", fades)} role="alert">
				Couldn't list the files: {treeError}
			</p>
		);
	}
	if (!tree) {
		return (
			<p className={cn(ROW, "text-muted-foreground")} role="status">
				Loading files…
			</p>
		);
	}
	if (tree.files.length === 0)
		return <p className={cn(ROW, "text-muted-foreground", fades)}>{branch} has no files yet.</p>;
	return (
		<ul className={cn(ROOT, fades)}>
			{buildTree(tree.files).map((node) => (
				<Node key={node.path} node={node} holders={holders} depth={0} />
			))}
		</ul>
	);
}

/** Which open change holds which part of the repo, over its file tree. */
export function ClaimsMap({ branch, holders, tree, treeError }: ClaimsMapProps) {
	const elsewhere = tree ? claimedElsewhere(tree.files, holders) : [];
	// What comes with the files, once they load, fades in with them.
	const loaded = useChanged(!!tree) && "animate-fade";
	return (
		<div className="grid min-w-0 gap-4">
			<Box aria-labelledby="claims-legend-title">
				<BoxHeader>
					<h2 id="claims-legend-title" className="text-body-sm">
						Open changes and their claims
					</h2>
				</BoxHeader>
				{holders.length ? (
					<ul className="m-0 grid list-none gap-2 px-4 py-3">
						{holders.map((holder) => (
							// The swatch, then the change's text, wrapping under itself rather than under the swatch.
							<li key={holder.change} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 wrap-anywhere">
								<Swatch holder={holder} className="mt-[0.3em] self-start" />
								<span>
									<a href={holder.href}>{holder.title}</a>
									<span className="text-muted-foreground">
										{" "}
										· {holder.agent} · {holder.paths.length} {holder.paths.length === 1 ? "path" : "paths"}
									</span>
									{holder.conflicts.length ? (
										<span className="ml-2 inline-flex items-center gap-1 text-meta text-warn">
											<Icon name="conflict" size={14} /> conflicts in {holder.conflicts.length}{" "}
											{holder.conflicts.length === 1 ? "file" : "files"}
										</span>
									) : null}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className={cn(ROW, "text-muted-foreground")}>
						No open change holds a claim right now: every path is free.
					</p>
				)}
			</Box>

			<Box aria-labelledby="claims-tree-title">
				<BoxHeader>
					<h2 id="claims-tree-title" className="text-body-sm">
						Files on {branch}
					</h2>
					{tree ? <span className={cn("text-muted-foreground", loaded)}>{tree.files.length} files</span> : null}
				</BoxHeader>
				<FileTree branch={branch} holders={holders} tree={tree} treeError={treeError} />
				{tree?.truncated ? (
					<p className={cn(ROW, "border-t border-border text-muted-foreground")}>
						This repo is very large: only part of its file list is shown, so some claims may not appear.
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
								<a
									href={holder.href}
									className={cn(ITEM, held(holder, true))}
									title={`${holder.title} · ${holder.agent}`}
								>
									<Icon name={path.endsWith("/") ? "folder" : "file"} size={14} className="text-muted-foreground" />
									<span className="min-w-0 wrap-anywhere">{path}</span>
									<span className="ml-auto font-sans text-caption whitespace-nowrap text-muted-foreground">
										{holder.title}
									</span>
								</a>
							</li>
						))}
					</ul>
				</Box>
			) : null}
		</div>
	);
}

/** The Claims tab with its loading: the file tree at the project's branch. */
export function ClaimsTab({
	repo,
	branch,
	holders,
	api,
}: {
	repo: string;
	branch: string;
	holders: ClaimHolder[];
	api: Pick<CodeApi, "tree">;
}) {
	const tree = usePoll(`tree:${repo}:${branch}`, () => api.tree(repo, branch), 60_000);
	return (
		<ClaimsMap branch={branch} holders={holders} tree={tree.data} treeError={tree.data ? undefined : tree.error} />
	);
}
