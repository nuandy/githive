import type { RepoFile, RepoTree } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { useStagger } from "../hooks/useStagger";
import { shortSha } from "../lib/model";
import { counted } from "../lib/plural";
import { splitRepo } from "../lib/repoName";
import { href } from "../lib/routes";
import { listDir, normalizePath, pathCrumbs, pathKind } from "../lib/tree";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Box, BoxHeader, Callout } from "./ui/box";
import { Empty } from "./ui/empty";

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

/** What the body shows, by path and how far it has loaded: each new one fades in where the last was. */
function bodyPhase(
	tree: RepoTree | undefined,
	treeError: string | undefined,
	path: string,
	file: RepoFile | undefined,
	fileError: string | undefined,
): string {
	if (treeError) return "tree-error";
	if (!tree) return "loading";
	const kind = pathKind(tree.files, path);
	if (kind !== "file") return `${kind}:${path}`;
	return `file:${path}:${file ? "shown" : fileError ? "error" : "loading"}`;
}

/** The Code tab, given what it has loaded: a folder listing or one file with line numbers. */
export function CodeView({ repo, path, refParam, branch, tree, treeError, file, fileError }: CodeViewProps) {
	const clean = normalizePath(path);
	const shownRef = refParam ?? branch;
	const link = (target: string) => href.code(repo, target, refParam);
	// Another folder or file, or what loads where "Loading" was, fades in; what's there first comes with the page.
	const phase = bodyPhase(tree, treeError, clean, file, fileError);
	const fades = useChanged(phase) && "animate-fade";
	return (
		<section className="grid min-w-0 gap-3" aria-labelledby="code-title">
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
				<Badge
					outline
					className="font-mono text-caption leading-4.5"
					title={tree ? `At commit ${tree.commit}` : undefined}
				>
					<Icon name="commit" size={13} />
					{refParam ? shortSha(refParam) : shownRef}
				</Badge>
				{refParam ? (
					<a href={href.code(repo, clean)} className="text-ui">
						Back to {branch}
					</a>
				) : null}
				<nav aria-label="File path" className="min-w-0">
					<h2 id="code-title" className="text-lead font-normal wrap-anywhere [&_a]:font-semibold">
						<a href={link("")}>{splitRepo(repo).name}</a>
						{pathCrumbs(clean).map((crumb, index, all) => (
							<span key={crumb.path}>
								<span className="mx-1 text-muted-foreground">/</span>
								{index === all.length - 1 ? (
									<strong aria-current="page">{crumb.name}</strong>
								) : (
									<a href={link(crumb.path)}>{crumb.name}</a>
								)}
							</span>
						))}
					</h2>
				</nav>
			</div>

			<div key={phase} className={cn("min-w-0", fades)}>
				<CodeBody
					tree={tree}
					treeError={treeError}
					path={clean}
					shownRef={shownRef}
					link={link}
					file={file}
					fileError={fileError}
				/>
			</div>
			{tree?.truncated ? (
				<p className="m-0 text-ui text-muted-foreground">
					This repo is very large: only part of its file list is shown.
				</p>
			) : null}
		</section>
	);
}

interface CodeBodyProps {
	tree: RepoTree | undefined;
	treeError: string | undefined;
	/** The normalized path shown. */
	path: string;
	shownRef: string;
	link(path: string): string;
	file: RepoFile | undefined;
	fileError: string | undefined;
}

/** What's at the path: the listing's error or loading, nothing, a folder's entries, or a file. */
function CodeBody({ tree, treeError, path, shownRef, link, file, fileError }: CodeBodyProps) {
	if (treeError)
		return (
			<Callout tone="bad" role="alert">
				<Icon name="x" className="text-bad" />
				<div>
					<strong>Couldn't list the files</strong>
					<p>{treeError}</p>
				</div>
			</Callout>
		);
	if (!tree)
		return (
			<p className="my-3.75 text-muted-foreground" role="status">
				Loading files…
			</p>
		);
	const kind = pathKind(tree.files, path);
	if (kind === "missing")
		return (
			<Box asChild>
				<Empty>
					<Icon name="file" size={28} />
					<h2>Nothing at this path</h2>
					<p>
						<code>{path}</code> isn't on {shownRef}. <a href={link("")}>Go to the top</a>.
					</p>
				</Empty>
			</Box>
		);
	if (kind === "dir") return <FolderView files={tree.files} path={path} link={link} />;
	return <FileView file={file} error={fileError} path={path} />;
}

/** A folder's entry: a row that lights up under the pointer. */
const ENTRY = cn(
	"flex items-center gap-2.5 px-4 py-2 text-foreground wrap-anywhere",
	"transition-colors duration-fast hover:bg-surface-2 hover:text-link hover:no-underline",
);

function FolderView({ files, path, link }: { files: string[]; path: string; link(path: string): string }) {
	const parent = path.split("/").slice(0, -1).join("/");
	const staggers = useStagger(true);
	return (
		<Box asChild>
			<div>
				<ul className={cn("m-0 list-none p-0", staggers && "stagger")}>
					{path ? (
						<li>
							<a href={link(parent)} className={ENTRY}>
								<Icon name="folder" className="text-muted-foreground" />
								<span>..</span>
							</a>
						</li>
					) : null}
					{listDir(files, path).map((entry) => {
						const isDir = entry.kind === "dir";
						return (
							<li key={entry.path} className="border-border not-first:border-t">
								<a href={link(entry.path)} className={ENTRY}>
									<Icon name={isDir ? "folder" : "file"} className={isDir ? "text-link" : "text-muted-foreground"} />
									<span>{entry.name}</span>
								</a>
							</li>
						);
					})}
				</ul>
			</div>
		</Box>
	);
}

function FileView({ file, error, path }: { file?: RepoFile; error?: string; path: string }) {
	if (error)
		return (
			<Callout tone="bad" role="alert">
				<Icon name="x" className="text-bad" />
				<div>
					<strong>Couldn't open {path}</strong>
					<p>{error}</p>
				</div>
			</Callout>
		);
	if (!file)
		return (
			<p className="my-3.75 text-muted-foreground" role="status">
				Loading {path}…
			</p>
		);
	const lines = file.text !== undefined ? file.text.replace(/\n$/, "").split("\n") : [];
	const lineCount = file.text !== undefined ? `${counted(lines.length, "line")} · ` : "";
	return (
		<Box asChild className="overflow-hidden">
			<div>
				<BoxHeader className="text-meta text-muted-foreground">
					<span>
						{lineCount}
						{formatSize(file.size)}
					</span>
				</BoxHeader>
				<FileContents file={file} lines={lines} path={path} />
			</div>
		</Box>
	);
}

/** A line under the file's header saying why its contents aren't shown. */
const NOT_SHOWN = "my-3.75 px-0.5 py-3 text-muted-foreground";

function FileContents({ file, lines, path }: { file: RepoFile; lines: string[]; path: string }) {
	if (file.binary) return <p className={NOT_SHOWN}>This is a binary file, so it isn't shown.</p>;
	if (file.tooBig) return <p className={NOT_SHOWN}>This file is too big to show here.</p>;
	return (
		<div className="max-h-[75vh] overflow-auto" tabIndex={0} role="region" aria-label={`Contents of ${path}`}>
			<table className="w-full border-collapse font-mono text-caption leading-[1.6] [tab-size:2]">
				<tbody>
					{lines.map((line, index) => (
						<tr key={index} className="transition-colors duration-fast hover:bg-surface-2">
							<td
								className="w-[1%] min-w-11 px-3 py-0 text-right align-top whitespace-nowrap text-muted-foreground select-none"
								aria-hidden="true"
							>
								{index + 1}
							</td>
							<td className="px-3 py-0 whitespace-pre">{line || " "}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** The Code tab with its loading: the listing at the project's branch (or the address's ref), and the file shown. */
export function CodeTab({
	repo,
	path,
	refParam,
	branch,
	api,
}: Omit<CodeViewProps, "tree" | "treeError" | "file" | "fileError"> & { api: CodeApi }) {
	const ref = refParam ?? branch;
	const tree = usePoll(`tree:${repo}:${ref}`, () => api.tree(repo, ref), 60_000);
	const clean = normalizePath(path);
	const isFile = !!tree.data && pathKind(tree.data.files, clean) === "file";
	const file = usePoll(isFile ? `file:${repo}:${ref}:${clean}` : null, () => api.file(repo, clean, ref), 60_000);
	return (
		<CodeView
			repo={repo}
			path={path}
			refParam={refParam}
			branch={branch}
			tree={tree.data}
			treeError={tree.data ? undefined : tree.error}
			file={file.data}
			fileError={file.data ? undefined : file.error}
		/>
	);
}
