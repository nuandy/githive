import type { RepoTree } from "../api";
import { usePoll } from "../hooks/usePoll";
import { claimedElsewhere, holderOf, holdsInside, type ClaimHolder } from "../lib/claimsMap";
import { buildTree, type TreeNode } from "../lib/tree";
import type { CodeApi } from "./CodeBrowser";
import { Icon } from "./Icon";
import "./ClaimsMap.css";

export interface ClaimsMapProps {
	branch: string;
	holders: ClaimHolder[];
	tree?: RepoTree;
	treeError?: string;
}

function Swatch({ holder }: { holder: ClaimHolder }) {
	return <span className={`claims__swatch claim-c${holder.color}`} aria-hidden="true" />;
}

function Node({ node, holders, depth }: { node: TreeNode; holders: ClaimHolder[]; depth: number }) {
	const holder = holderOf(node.path, holders);
	const label = holder ? `${node.name}, claimed by ${holder.title}` : node.name;
	if (node.kind === "file") {
		const conflict = holder?.conflicts.includes(node.path);
		const content = (
			<>
				<Icon name="file" size={14} className="muted" />
				<span className="claims__name">{node.name}</span>
				{conflict ? (
					<span className="claims__conflict tone-warn" title="Open changes conflict in this file">
						<Icon name="conflict" size={13} label="conflict" />
					</span>
				) : null}
			</>
		);
		return (
			<li>
				{holder ? (
					<a href={holder.href} className={`claims__item claims__item--held claim-c${holder.color}`} aria-label={label} title={`${holder.title} · ${holder.agent}`}>
						{content}
					</a>
				) : (
					<span className="claims__item">{content}</span>
				)}
			</li>
		);
	}
	const open = depth === 0 ? holdsInside(node.path, holders) || node.children.length < 12 : holdsInside(node.path, holders);
	return (
		<li>
			<details open={open}>
				<summary className={`claims__item claims__dir${holder ? ` claims__item--held claim-c${holder.color}` : ""}`} title={holder ? `${holder.title} · ${holder.agent}` : undefined}>
					<Icon name="chevron" size={13} className="claims__chevron" />
					<Icon name="folder" size={14} className="claims__folder" />
					<span className="claims__name">{node.name}</span>
					{holder ? <span className="sr-only">, claimed by {holder.title}</span> : null}
				</summary>
				<ul className="claims__tree">
					{node.children.map((child) => (
						<Node key={child.path} node={child} holders={holders} depth={depth + 1} />
					))}
				</ul>
			</details>
		</li>
	);
}

/** Which open change holds which part of the repo, over its file tree. */
export function ClaimsMap({ branch, holders, tree, treeError }: ClaimsMapProps) {
	const elsewhere = tree ? claimedElsewhere(tree.files, holders) : [];
	return (
		<div className="claims">
			<section className="box" aria-labelledby="claims-legend-title">
				<div className="box__header">
					<h2 id="claims-legend-title">Open changes and their claims</h2>
				</div>
				{holders.length ? (
					<ul className="claims__legend">
						{holders.map((holder) => (
							<li key={holder.change}>
								<Swatch holder={holder} />
								<a href={holder.href}>{holder.title}</a>
								<span className="muted">
									{" "}
									· {holder.agent} · {holder.paths.length} {holder.paths.length === 1 ? "path" : "paths"}
								</span>
								{holder.conflicts.length ? (
									<span className="tone-warn claims__legend-conflict">
										<Icon name="conflict" size={13} /> conflicts in {holder.conflicts.length} {holder.conflicts.length === 1 ? "file" : "files"}
									</span>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<p className="box__row muted">No open change holds a claim right now: every path is free.</p>
				)}
			</section>

			<section className="box" aria-labelledby="claims-tree-title">
				<div className="box__header">
					<h2 id="claims-tree-title">Files on {branch}</h2>
					{tree ? <span className="muted">{tree.files.length} files</span> : null}
				</div>
				{treeError ? (
					<p className="box__row tone-bad" role="alert">
						Couldn't list the files: {treeError}
					</p>
				) : !tree ? (
					<p className="box__row muted" role="status">
						Loading files…
					</p>
				) : tree.files.length === 0 ? (
					<p className="box__row muted">{branch} has no files yet.</p>
				) : (
					<ul className="claims__tree claims__tree--root">
						{buildTree(tree.files).map((node) => (
							<Node key={node.path} node={node} holders={holders} depth={0} />
						))}
					</ul>
				)}
				{tree?.truncated ? <p className="box__row muted">This repo is very large: only part of its file list is shown, so some claims may not appear.</p> : null}
			</section>

			{elsewhere.length ? (
				<section className="box" aria-labelledby="claims-new-title">
					<div className="box__header">
						<h2 id="claims-new-title">Claimed, not on {branch} yet</h2>
					</div>
					<ul className="claims__tree claims__tree--root">
						{elsewhere.map(({ path, holder }) => (
							<li key={`${holder.change}:${path}`}>
								<a href={holder.href} className={`claims__item claims__item--held claim-c${holder.color}`} title={`${holder.title} · ${holder.agent}`}>
									<Icon name={path.endsWith("/") ? "folder" : "file"} size={14} className="muted" />
									<span className="claims__name">{path}</span>
									<span className="muted claims__owner">{holder.title}</span>
								</a>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}

/** The Claims tab with its loading: the file tree at the project's branch. */
export function ClaimsTab({ repo, branch, holders, api }: { repo: string; branch: string; holders: ClaimHolder[]; api: Pick<CodeApi, "tree"> }) {
	const tree = usePoll(`tree:${repo}:${branch}`, () => api.tree(repo, branch), 60_000);
	return <ClaimsMap branch={branch} holders={holders} tree={tree.data} treeError={tree.data ? undefined : tree.error} />;
}
