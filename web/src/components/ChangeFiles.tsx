import { useEffect, useRef, useState } from "react";
import type { ChangeDiff, DiffHunk, FileDiff } from "../api";
import { shortSha } from "../lib/model";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { LoadError } from "./LoadError";
import { Badge } from "./ui/badge";
import { Box } from "./ui/box";
import { Empty } from "./ui/empty";

// A change's Files tab: what it changed since it left its branch (or what it brought, once landed), a fold per file
// with its path, its lines added and removed, and whether it's outside the change's claim. A file's lines are drawn
// only while it's open, so a long change stays light; long files start folded, and the file an address asks for
// starts open, scrolled to.

/** A file with more lines than this starts folded. */
const LONG = 200;

const linesOf = (file: FileDiff) => (file.hunks ?? []).reduce((sum, hunk) => sum + hunk.lines.length, 0);

/** "+12 −3", each in its lamp's color, with its sign so color doesn't say it alone. */
function Counts({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="inline-flex gap-1.5 font-mono text-caption whitespace-nowrap">
			<span className="text-good">+{added}</span>
			<span className="text-bad">−{removed}</span>
		</span>
	);
}

/** "@@ -10,3 +10,4 @@", as git heads a hunk. */
const hunkHeader = (hunk: DiffHunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

const ROW = {
	"+": { row: "bg-diff-add", number: "bg-diff-add-strong" },
	"-": { row: "bg-diff-del", number: "bg-diff-del-strong" },
	" ": { row: "", number: "" },
} as const;
const NUMBER = "w-0 min-w-10 px-2 text-right align-top text-muted-foreground select-none";

/** A hunk's lines, each with its old and new line numbers. */
function HunkRows({ hunk }: { hunk: DiffHunk }) {
	let [old, now] = [hunk.oldStart, hunk.newStart];
	return (
		<>
			<tr className="bg-link-soft text-muted-foreground">
				<td colSpan={3} className="px-3 py-1">
					{hunkHeader(hunk)}
				</td>
			</tr>
			{hunk.lines.map((line, index) => {
				if (line.startsWith("\\"))
					return (
						<tr key={index} className="text-muted-foreground">
							<td className={NUMBER} />
							<td className={NUMBER} />
							<td className="px-3 italic">{line.slice(2)}</td>
						</tr>
					);
				const mark = (line[0] ?? " ") as keyof typeof ROW;
				const look = ROW[mark] ?? ROW[" "];
				const numbers = [mark === "+" ? "" : old++, mark === "-" ? "" : now++];
				return (
					<tr key={index} className={look.row}>
						<td className={cn(NUMBER, look.number)}>{numbers[0]}</td>
						<td className={cn(NUMBER, look.number)}>{numbers[1]}</td>
						<td className="pr-4 pl-3 whitespace-pre">{line}</td>
					</tr>
				);
			})}
		</>
	);
}

/** Why a file's lines aren't shown, with the file at the change's head in the code browser. */
function NotShown({ file, repo, head }: { file: FileDiff; repo: string; head: string }) {
	const why = file.binary
		? "Binary file: not shown."
		: file.tooBig
			? "Too big to show here: one of its sides is over 256 KB."
			: "Its lines are left out: this change's diff is past 900 KB.";
	return (
		<p className="m-0 flex flex-wrap gap-x-2 border-t border-border px-3 py-2.5 text-ui text-muted-foreground">
			{why}
			{file.status === "removed" ? null : (
				<a href={href.code(repo, file.path, head)}>
					See it at <code>{shortSha(head)}</code>
				</a>
			)}
		</p>
	);
}

/** One file: its fold, with its lines while open. */
function FileFold({
	file,
	index,
	repo,
	head,
	asked,
}: {
	file: FileDiff;
	index: number;
	repo: string;
	head: string;
	asked: boolean;
}) {
	const diffed = !!file.hunks;
	const [open, setOpen] = useState(asked || !diffed || linesOf(file) <= LONG);
	const ref = useRef<HTMLLIElement>(null);
	useEffect(() => {
		if (!asked) return;
		ref.current?.scrollIntoView({ block: "start" });
		ref.current?.querySelector("summary")?.focus({ preventScroll: true });
	}, [asked]);
	const counts = file.added !== undefined && file.removed !== undefined;
	return (
		<li
			ref={ref}
			id={`file-${index}`}
			className="min-w-0 scroll-mt-[calc(var(--topbar-height)+12px)] rounded-md border border-border bg-card"
		>
			<details className="disclosure group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
				<summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 [&::-webkit-details-marker]:hidden">
					<Icon
						name="chevron"
						size={14}
						className="shrink-0 -rotate-90 text-muted-foreground transition-transform duration-fast group-open:rotate-0"
					/>
					<code className="min-w-0 bg-transparent p-0 font-semibold wrap-anywhere">{file.path}</code>
					{file.status === "modified" ? null : (
						<Badge size="sm" tone={file.status === "added" ? "good" : "bad"}>
							{file.status}
						</Badge>
					)}
					{file.outside ? (
						<Badge size="sm" tone="warn">
							<Icon name="alert" size={14} />
							outside its claim
						</Badge>
					) : null}
					<span className="ml-auto">{counts ? <Counts added={file.added!} removed={file.removed!} /> : null}</span>
				</summary>
				{open ? (
					file.hunks && !file.cut ? (
						<div className="overflow-x-auto border-t border-border">
							<table className="w-full border-collapse font-mono text-caption leading-[1.6]">
								<caption className="sr-only">Lines changed in {file.path}</caption>
								<thead className="sr-only">
									<tr>
										<th>Line before</th>
										<th>Line after</th>
										<th>Text</th>
									</tr>
								</thead>
								<tbody>
									{file.hunks.map((hunk, hunkIndex) => (
										<HunkRows key={hunkIndex} hunk={hunk} />
									))}
								</tbody>
							</table>
						</div>
					) : (
						<NotShown file={file} repo={repo} head={head} />
					)
				) : null}
			</details>
		</li>
	);
}

/** The tab: how many files and lines, against what, then a fold per file. */
export function ChangeFiles({
	repo,
	diff,
	error,
	onRetry,
	head,
	into,
	file,
	className,
}: {
	repo: string;
	changeId: string;
	/** Undefined while loading, null when it couldn't be read. */
	diff: ChangeDiff | null | undefined;
	error?: string | undefined;
	onRetry?: () => void;
	/** The change's head now, to say when the files are an earlier push's. */
	head?: string | null | undefined;
	/** The branch it lands on. */
	into: string;
	/** The file the address asks for. */
	file?: string | undefined;
	className?: string;
}) {
	if (!diff) {
		if (diff === null || error)
			return <LoadError what="This change's files" error={error ?? "it couldn't be read"} onRetry={onRetry} />;
		return (
			<p className="my-[1em] text-muted-foreground" role="status">
				Reading its files…
			</p>
		);
	}
	if (!diff.head || !diff.total)
		return (
			<Box asChild>
				<Empty className={className}>
					<Icon name="file" size={28} />
					<h2>{diff.head ? "No files changed" : "Nothing is pushed yet"}</h2>
					<p>
						{diff.head
							? `Its head is the same as ${into} where it left it.`
							: "Its files show here once its agent pushes."}
					</p>
				</Empty>
			</Box>
		);
	const totals = diff.files.reduce(
		(sum, each) => ({ added: sum.added + (each.added ?? 0), removed: sum.removed + (each.removed ?? 0) }),
		{ added: 0, removed: 0 },
	);
	const earlier = diff.of === "head" && !!head && head !== diff.head;
	return (
		<section className={cn("grid min-w-0 gap-3", className)} aria-labelledby="files-title">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 id="files-title" className="text-body-sm">
					{counted(diff.total, "file")} changed
				</h2>
				<Counts {...totals} />
				<span className="text-ui text-muted-foreground">
					{diff.of === "landed" ? (
						<>
							as it landed on {into}, in <code>{shortSha(diff.head)}</code>
						</>
					) : (
						<>
							<code>{shortSha(diff.head)}</code> against {into} where it left it, at <code>{shortSha(diff.base)}</code>
						</>
					)}
				</span>
			</div>
			{earlier ? (
				<p className="m-0 text-ui text-warn" role="status">
					These are an earlier push's files: the latest, <code>{shortSha(head)}</code>, is being read.
				</p>
			) : null}
			<ol className="m-0 grid list-none gap-2.5 p-0">
				{diff.files.map((each, index) => (
					<FileFold
						key={each.path}
						file={each}
						index={index}
						repo={repo}
						head={diff.head!}
						asked={each.path === file}
					/>
				))}
			</ol>
			{diff.total > diff.files.length ? (
				<p className="m-0 text-ui text-muted-foreground">
					And {counted(diff.total - diff.files.length, "more file")}, past the {diff.files.length} shown.
				</p>
			) : null}
		</section>
	);
}
