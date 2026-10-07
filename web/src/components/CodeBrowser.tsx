import type { RepoFile, RepoTree } from "../api";
import { usePoll } from "../hooks/usePoll";
import { shortSha } from "../lib/model";
import { href } from "../lib/routes";
import { listDir, normalizePath, pathCrumbs, pathKind } from "../lib/tree";
import { Icon } from "./Icon";
import "./CodeBrowser.css";

export interface CodeApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	file(repo: string, path: string, ref?: string): Promise<RepoFile>;
}

export interface CodeViewProps {
	repo: string;
	/** The file or folder shown ("" for the top). */
	path: string;
	/** A commit or branch other than the project's branch, from the address. */
	refParam?: string;
	/** The project's branch. */
	branch: string;
	tree?: RepoTree;
	treeError?: string;
	file?: RepoFile;
	fileError?: string;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The Code tab, given what it has loaded: a folder listing or one file with line numbers. */
export function CodeView({ repo, path, refParam, branch, tree, treeError, file, fileError }: CodeViewProps) {
	const clean = normalizePath(path);
	const shownRef = refParam ?? branch;
	const link = (p: string) => href.code(repo, p, refParam);
	const kind = tree ? pathKind(tree.files, clean) : undefined;
	return (
		<section className="code" aria-labelledby="code-title">
			<div className="code__bar">
				<span className="pill pill--outline code__ref" title={tree ? `At commit ${tree.commit}` : undefined}>
					<Icon name="commit" size={13} />
					{refParam ? shortSha(refParam) : shownRef}
				</span>
				{refParam ? (
					<a href={href.code(repo, clean)} className="code__back">
						Back to {branch}
					</a>
				) : null}
				<nav aria-label="File path" className="code__crumbs">
					<h2 id="code-title" className="code__path">
						<a href={link("")}>{repo}</a>
						{pathCrumbs(clean).map((crumb, index, all) => (
							<span key={crumb.path}>
								<span className="code__slash">/</span>
								{index === all.length - 1 ? <strong aria-current="page">{crumb.name}</strong> : <a href={link(crumb.path)}>{crumb.name}</a>}
							</span>
						))}
					</h2>
				</nav>
			</div>

			{treeError ? (
				<div className="callout callout--bad" role="alert">
					<Icon name="x" className="tone-bad" />
					<div>
						<strong>Couldn't list the files</strong>
						<p>{treeError}</p>
					</div>
				</div>
			) : !tree ? (
				<p className="muted" role="status">
					Loading files…
				</p>
			) : kind === "missing" ? (
				<div className="box empty">
					<Icon name="file" size={28} className="muted" />
					<h2>Nothing at this path</h2>
					<p>
						<code>{clean}</code> isn't on {shownRef}. <a href={link("")}>Go to the top</a>.
					</p>
				</div>
			) : kind === "dir" ? (
				<div className="box">
					<ul className="code__entries">
						{clean ? (
							<li>
								<a href={link(clean.split("/").slice(0, -1).join("/"))} className="code__entry">
									<Icon name="folder" className="muted" />
									<span>..</span>
								</a>
							</li>
						) : null}
						{listDir(tree.files, clean).map((entry) => (
							<li key={entry.path}>
								<a href={link(entry.path)} className="code__entry">
									<Icon name={entry.kind === "dir" ? "folder" : "file"} className={entry.kind === "dir" ? "code__folder" : "muted"} />
									<span>{entry.name}</span>
								</a>
							</li>
						))}
					</ul>
				</div>
			) : (
				<FileView file={file} error={fileError} path={clean} />
			)}
			{tree?.truncated ? <p className="muted code__note">This repo is very large: only part of its file list is shown.</p> : null}
		</section>
	);
}

function FileView({ file, error, path }: { file?: RepoFile; error?: string; path: string }) {
	if (error)
		return (
			<div className="callout callout--bad" role="alert">
				<Icon name="x" className="tone-bad" />
				<div>
					<strong>Couldn't open {path}</strong>
					<p>{error}</p>
				</div>
			</div>
		);
	if (!file)
		return (
			<p className="muted" role="status">
				Loading {path}…
			</p>
		);
	const lines = file.text !== undefined ? file.text.replace(/\n$/, "").split("\n") : [];
	return (
		<div className="box code__file">
			<div className="box__header code__file-header">
				<span>
					{file.text !== undefined ? `${lines.length} ${lines.length === 1 ? "line" : "lines"} · ` : ""}
					{formatSize(file.size)}
				</span>
			</div>
			{file.binary ? (
				<p className="box__row muted">This is a binary file, so it isn't shown.</p>
			) : file.tooBig ? (
				<p className="box__row muted">This file is too big to show here.</p>
			) : (
				<div className="code__scroll" tabIndex={0} role="region" aria-label={`Contents of ${path}`}>
					<table className="code__lines">
						<tbody>
							{lines.map((line, index) => (
								<tr key={index}>
									<td className="code__no" aria-hidden="true">
										{index + 1}
									</td>
									<td className="code__text">{line || " "}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

/** The Code tab with its loading: the listing at the project's branch (or the address's ref), and the file shown. */
export function CodeTab({ repo, path, refParam, branch, api }: Omit<CodeViewProps, "tree" | "treeError" | "file" | "fileError"> & { api: CodeApi }) {
	const ref = refParam ?? branch;
	const tree = usePoll(`tree:${repo}:${ref}`, () => api.tree(repo, ref), 60_000);
	const clean = normalizePath(path);
	const isFile = !!tree.data && pathKind(tree.data.files, clean) === "file";
	const file = usePoll(isFile ? `file:${repo}:${ref}:${clean}` : null, () => api.file(repo, clean, ref), 60_000);
	return (
		<CodeView repo={repo} path={path} refParam={refParam} branch={branch} tree={tree.data} treeError={tree.data ? undefined : tree.error} file={file.data} fileError={file.data ? undefined : file.error} />
	);
}
