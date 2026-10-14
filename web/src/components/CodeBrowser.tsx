import { type ReactNode, useState } from "react";
import type { BranchHistory, RepoFile, RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { useStagger } from "../hooks/useStagger";
import { type ClaimHolder, holderOf, holdersFromSnapshot } from "../lib/claimsMap";
import { languageOf } from "../lib/highlight";
import { type LastChange, lastChangeTo } from "../lib/landed";
import { FORMAT_MOST, isMarkdown } from "../lib/markdown";
import { shortSha, shortTitle } from "../lib/model";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { splitRepo } from "../lib/repoName";
import { href } from "../lib/routes";
import { STATES } from "../lib/status";
import { listDir, normalizePath, pathCrumbs, pathKind } from "../lib/tree";
import { cn } from "../lib/utils";
import { TokenLine, useHighlighted } from "./Highlighted";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { StateMark } from "./StateMark";
import { Badge } from "./ui/badge";
import { Box, BoxHeader, Callout } from "./ui/box";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Empty } from "./ui/empty";
import { Segmented } from "./ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export interface CodeApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	file(repo: string, path: string, ref?: string): Promise<RepoFile>;
}

/** What else the Code tab reads, where the dashboard has it: what's landed, and what's being checked to land. */
export interface CodeExtrasApi {
	history?: (repo: string, branch: string) => Promise<BranchHistory>;
	landing?: (repo: string, branch: string) => Promise<RepoLanding>;
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
	/** The other branches changes land on, to switch to. */
	branches?: string[];
	/** The open change that holds the path shown, if one does. */
	holder?: ClaimHolder;
	/** The last landed change to touch the file shown, as History has it, and whether History can be sure of it. */
	lastChange?: LastChange;
	/** Show a Markdown file's source rather than formatted (tests set it). */
	source?: boolean;
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
export function CodeView({
	repo,
	path,
	refParam,
	branch,
	tree,
	treeError,
	file,
	fileError,
	branches = [],
	holder,
	lastChange,
	source,
}: CodeViewProps) {
	const clean = normalizePath(path);
	const shownRef = refParam ?? branch;
	const link = (target: string) => href.code(repo, target, refParam);
	// Another folder or file, or what loads where "Loading" was, fades in; what's there first comes with the page.
	const phase = bodyPhase(tree, treeError, clean, file, fileError);
	const fades = useChanged(phase) && "animate-fade";
	return (
		<section className="grid min-w-0 gap-3" aria-labelledby="code-title">
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
				<RefMenu repo={repo} path={clean} refParam={refParam} branch={branch} branches={branches} tree={tree} />
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

			{holder && clean ? <ClaimBanner path={clean} holder={holder} /> : null}
			{lastChange ? <LastChangeLine repo={repo} last={lastChange} /> : null}
			<div key={phase} className={cn("min-w-0", fades)}>
				<CodeBody
					repo={repo}
					tree={tree}
					treeError={treeError}
					path={clean}
					refParam={refParam}
					shownRef={shownRef}
					link={link}
					file={file}
					fileError={fileError}
					source={source}
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

/**
 * Which branch or commit the code is shown at: a chip, or with other branches to go to, a menu of them (the project's
 * first) that sets the address's ref. On a branch, a tooltip says which commit it's at.
 */
function RefMenu({
	repo,
	path,
	refParam,
	branch,
	branches,
	tree,
}: {
	repo: string;
	path: string;
	refParam: string | undefined;
	branch: string;
	branches: string[];
	tree: RepoTree | undefined;
}) {
	const names = [branch, ...branches.filter((name) => name !== branch).sort()];
	const current = refParam ?? branch;
	const onBranch = names.includes(current);
	const label = onBranch ? current : shortSha(current);
	// At a commit, the chip names it already.
	const commit = tree && onBranch ? shortSha(tree.commit) : undefined;
	const hinted = (trigger: ReactNode) =>
		commit ? (
			<Tooltip>
				<TooltipTrigger asChild>{trigger}</TooltipTrigger>
				<TooltipContent>At commit {commit}</TooltipContent>
			</Tooltip>
		) : (
			trigger
		);
	if (names.length < 2)
		return hinted(
			<Badge outline className="font-mono text-caption leading-4.5" tabIndex={commit ? 0 : undefined}>
				<Icon name="commit" size={14} />
				{label}
			</Badge>,
		);
	return (
		<DropdownMenu>
			{hinted(
				<DropdownMenuTrigger asChild>
					<Button
						size="sm"
						className="font-mono text-caption font-medium data-[state=open]:bg-surface-2"
						aria-label={`Branch: ${label}${commit ? `, at commit ${commit}` : ""}`}
					>
						<Icon name="commit" size={14} />
						{label}
						<Icon name="chevron" size={14} className="text-muted-foreground" />
					</Button>
				</DropdownMenuTrigger>,
			)}
			<DropdownMenuContent align="start">
				<DropdownMenuLabel>Show the code on</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={onBranch ? current : ""}
					onValueChange={(name) => {
						window.location.hash = href.code(repo, path, name === branch ? undefined : name);
					}}
				>
					{names.map((name) => (
						<DropdownMenuRadioItem key={name} value={name} className="font-mono">
							{name}
							{name === branch ? <span className="font-sans text-muted-foreground">project</span> : null}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Over a file or folder an open change holds: who holds it, for what, and where that change is. */
function ClaimBanner({ path, holder }: { path: string; holder: ClaimHolder }) {
	return (
		<Callout className="text-ui">
			<StateMark state={holder.state} className="mt-0.75 size-3.5 flex-none rounded-xs" />
			<p className="m-0">
				<code>{path}</code> is claimed by {holder.agent} for “<a href={holder.href}>{shortTitle(holder.title)}</a>”,{" "}
				{STATES[holder.state].short}.
			</p>
		</Callout>
	);
}

/** Why History can't be sure a change was the last to touch a file. */
const UNSURE: Record<NonNullable<LastChange["unsure"]>, string> = {
	cut: "A newer change touched more files than History lists, so it may have changed this one since.",
	unlisted:
		"Commits History doesn't list (pushed with plain git, or a revert) came after it, and may have changed this file.",
};

/**
 * The last landed change to touch the file, linked, with when it landed and its commit; hedged, with why in a tooltip,
 * where History can't be sure it's the last.
 */
function LastChangeLine({ repo, last }: { repo: string; last: LastChange }) {
	const { change, unsure } = last;
	return (
		<p className="m-0 text-ui text-muted-foreground">
			<Icon name="merge" size={14} className="mr-1.5 inline -mb-px align-baseline" />
			Last changed by <a href={href.change(repo, change.change)}>{shortTitle(change.title || change.change)}</a>
			{unsure ? (
				<>
					{" ("}
					<Tooltip>
						<TooltipTrigger asChild>
							<span tabIndex={0} className="underline decoration-dotted underline-offset-3">
								as far as GitHive's history shows
							</span>
						</TooltipTrigger>
						<TooltipContent>{UNSURE[unsure]}</TooltipContent>
					</Tooltip>
					)
				</>
			) : null}
			{change.at ? <>, landed {timeAgo(change.at)}</> : null}
			{" · "}
			<a href={href.code(repo, "", change.commit)}>
				<code>{shortSha(change.commit)}</code>
			</a>
		</p>
	);
}

interface CodeBodyProps {
	repo: string;
	refParam: string | undefined;
	source: boolean | undefined;
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
function CodeBody({ repo, refParam, source, tree, treeError, path, shownRef, link, file, fileError }: CodeBodyProps) {
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
	return <FileView repo={repo} refParam={refParam} file={file} error={fileError} path={path} source={source} />;
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

/**
 * A file: its size, then its lines numbered and in their syntax colors, or a Markdown file formatted, with its source
 * a click away. A Markdown file too long to format, or one that can't be, shows its source, saying why.
 */
function FileView({
	repo,
	refParam,
	file,
	error,
	path,
	source: sourceFirst = false,
}: {
	repo: string;
	refParam: string | undefined;
	file?: RepoFile;
	error?: string;
	path: string;
	source?: boolean;
}) {
	const [source, setSource] = useState(sourceFirst);
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
	const markdown = isMarkdown(path) && file.text !== undefined && !file.binary && !file.tooBig;
	const formatted = markdown && file.text!.length <= FORMAT_MOST;
	const dir = path.split("/").slice(0, -1).join("/");
	return (
		<Box asChild className="overflow-hidden">
			<div>
				<BoxHeader className="text-meta text-muted-foreground">
					<span>
						{lineCount}
						{formatSize(file.size)}
					</span>
					{formatted ? (
						<Segmented
							label={`Show ${path}`}
							className="ml-auto font-normal"
							options={[
								{ value: "formatted", words: "Formatted" },
								{ value: "source", words: "Source" },
							]}
							value={source ? "source" : "formatted"}
							onPick={(picked) => setSource(picked === "source")}
						/>
					) : null}
				</BoxHeader>
				{formatted && !source ? (
					<Markdown
						key="formatted"
						className="animate-fade px-1 py-5"
						source={file.text!}
						repo={repo}
						dir={dir}
						gitRef={refParam}
						fallback={
							<FileContents
								file={file}
								lines={lines}
								path={path}
								note="This file couldn't be formatted, so it's shown as its source."
							/>
						}
					/>
				) : (
					<FileContents
						key="source"
						file={file}
						lines={lines}
						path={path}
						note={markdown && !formatted ? "This file is too long to format, so it's shown as its source." : undefined}
					/>
				)}
			</div>
		</Box>
	);
}

/** A line under the file's header saying why its contents aren't shown. */
const NOT_SHOWN = "my-3.75 px-0.5 py-3 text-muted-foreground";

/** A file's lines, numbered and in their syntax colors, under a `note` saying why they're shown, if there's one. */
function FileContents({ file, lines, path, note }: { file: RepoFile; lines: string[]; path: string; note?: string }) {
	const highlighted = useHighlighted(file.binary || file.tooBig ? undefined : file.text, languageOf(path));
	if (file.binary) return <p className={NOT_SHOWN}>This is a binary file, so it isn't shown.</p>;
	if (file.tooBig) return <p className={NOT_SHOWN}>This file is too big to show here.</p>;
	return (
		<>
			{note ? <p className="m-0 border-b border-border px-4 py-2.5 text-ui text-muted-foreground">{note}</p> : null}
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
								<td className="px-3 py-0 whitespace-pre">
									{highlighted?.[index]?.length ? <TokenLine tokens={highlighted[index]} /> : line || " "}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

/**
 * The Code tab with its loading: the listing at the project's branch (or the address's ref), the file shown, and on a
 * branch, who holds the path and the last change to touch the file.
 */
export function CodeTab({
	repo,
	path,
	refParam,
	branch,
	api,
	snapshot,
}: Omit<CodeViewProps, "tree" | "treeError" | "file" | "fileError" | "branches" | "holder" | "lastChange"> & {
	api: CodeApi & CodeExtrasApi;
	/** The repo's claims and branches, once GitHive has started on it. */
	snapshot?: RepoSnapshot | null;
}) {
	const ref = refParam ?? branch;
	const tree = usePoll(`tree:${repo}:${ref}`, () => api.tree(repo, ref), 60_000);
	const clean = normalizePath(path);
	const isFile = !!tree.data && pathKind(tree.data.files, clean) === "file";
	const file = usePoll(isFile ? `file:${repo}:${ref}:${clean}` : null, () => api.file(repo, clean, ref), 60_000);
	const branches = (snapshot?.branches ?? []).map((other) => other.name);
	// Who holds what, and what's landed, are a branch's: at a commit, neither shows.
	const onBranch = ref === branch || branches.includes(ref) ? ref : undefined;
	const held = !!snapshot && !!onBranch && !!clean;
	const landing = usePoll(
		held && api.landing ? `landing:${repo}:${onBranch}` : null,
		() => api.landing!(repo, onBranch!),
		30_000,
	);
	const history = usePoll(
		isFile && onBranch && api.history ? `history:${repo}:${onBranch}` : null,
		() => api.history!(repo, onBranch!),
		60_000,
	);
	const holder = held
		? holderOf(clean, holdersFromSnapshot(snapshot, repo, { branch: onBranch, landing: landing.data }))
		: undefined;
	const lastChange = isFile && history.data ? lastChangeTo(clean, history.data.changes) : undefined;
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
			branches={branches}
			holder={holder}
			lastChange={lastChange}
		/>
	);
}
