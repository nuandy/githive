import type { MergeCheck, TouchedBy } from "../api";
import { shortSha } from "../lib/model";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { CopyBlock } from "./CopyBlock";
import { Icon } from "./Icon";

// A change's conflict with its branch, as the agent's last status found it: the files changed on both sides, who
// changed each since the change left the branch, the conflict markers, and the commands the agent runs next. People
// can't resolve it from here; the agent does, in its clone, and the result is reviewed and lands as before.

/** The most conflicted files the panel lists; the rest are counted. */
const FILES_SHOWN = 20;

type Hunk = NonNullable<MergeCheck["hunks"]>[number];

/** One commit that changed a conflicted file: its GitHive change and agent, or a plain push's author. */
function ChangedBy({ touched, repo }: { touched: TouchedBy; repo: string }) {
	return (
		<li>
			{touched.change ? (
				<>
					<a href={href.change(repo, touched.change)}>{touched.change}</a>
					{touched.agent ? (
						<>
							{" "}
							by <strong>{touched.agent}</strong>
						</>
					) : null}
				</>
			) : (
				<>
					a plain push by <strong>{touched.author || "someone"}</strong>
				</>
			)}
			{touched.intent ? <span className="text-muted-foreground"> · “{touched.intent}”</span> : null}{" "}
			<a href={href.code(repo, "", touched.commit)}>
				<code>{shortSha(touched.commit)}</code>
			</a>
		</li>
	);
}

/** A conflicted file: who changed it on the branch, and its conflict markers. */
function ConflictedFile({
	file,
	into,
	touchedBy,
	hunk,
	repo,
	fileHref,
}: {
	file: string;
	into: string;
	touchedBy: TouchedBy[];
	hunk: Hunk | undefined;
	repo: string;
	fileHref?: ((path: string) => string) | undefined;
}) {
	return (
		<li className="grid min-w-0 gap-1.5 border-t border-border px-4 py-3">
			<h3 className="flex items-center gap-1.5 text-ui">
				<Icon name="file" size={14} className="text-muted-foreground" />
				{fileHref ? (
					<a href={fileHref(file)} title="Its lines in this change's files">
						<code>{file}</code>
					</a>
				) : (
					<code>{file}</code>
				)}
			</h3>
			{touchedBy.length ? (
				<>
					<p className={LABEL}>Changed on {into} since this change left it, by:</p>
					<ul className="prose m-0 grid list-disc gap-0.75 pl-4.5 text-ui wrap-anywhere">
						{touchedBy.map((touched) => (
							<ChangedBy key={touched.commit} touched={touched} repo={repo} />
						))}
					</ul>
				</>
			) : (
				<p className={LABEL}>Who changed it on {into} wasn't found.</p>
			)}
			{hunk ? (
				<figure className="mx-0 mt-1 mb-0 min-w-0">
					<pre
						tabIndex={0}
						className={cn(
							"max-h-80 text-caption leading-[1.45] break-normal whitespace-pre",
							// Cut at 4 KB: the block's foot says so, in the warning tone.
							hunk.truncated && "rounded-b-none [border-bottom:2px_dashed_var(--amber)]",
						)}
					>
						<code>{hunk.content}</code>
					</pre>
					{hunk.truncated ? (
						<figcaption className="mt-1 text-caption text-warn">
							Cut at 4 KB: the whole file is in the agent's clone.
						</figcaption>
					) : null}
				</figure>
			) : null}
		</li>
	);
}

const LABEL = "m-0 text-meta text-muted-foreground";

/**
 * The conflict panel, when the change's last merge check found conflicts; nothing otherwise. In the conversation, with
 * a red rule. Each file links to its lines in the change's Files tab (`fileHref`); what its agent will run to resolve
 * it is folded away, for whoever wants to see it.
 */
export function ConflictPanel({
	merge,
	head,
	repo,
	fileHref,
	id,
	className,
}: {
	merge: MergeCheck;
	head?: string | null;
	repo: string;
	/** A file's place in the change's Files tab. */
	fileHref?: (path: string) => string;
	/** For the page to scroll to it and focus it. */
	id?: string;
	className?: string;
}) {
	const files = merge.conflicts ?? [];
	if (merge.clean || !files.length) return null;
	// The check is kept until the agent asks again, so it may be of an older push.
	const moved = !!head && !!merge.head && merge.head !== head;
	const shown = files.slice(0, FILES_SHOWN);
	// The fix ends with what to call once the commands are done: that's for the agent, not for a shell, so only the
	// commands are copied.
	const commands = (merge.fix ?? []).filter((line) => !line.startsWith("call "));
	const then = (merge.fix ?? []).filter((line) => line.startsWith("call "));
	return (
		<section
			id={id}
			tabIndex={id ? -1 : undefined}
			className={cn(
				"min-w-0 scroll-mt-[calc(var(--topbar-height)+12px)] rounded-md border border-[color-mix(in_srgb,var(--bad)_40%,var(--border))] border-l-3 border-l-bad bg-card",
				className,
			)}
			aria-labelledby="conflict-panel-title"
		>
			<div className="flex items-start gap-3 px-4 py-3">
				<span
					className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad"
					aria-hidden="true"
				>
					<Icon name="conflict" />
				</span>
				<div className="min-w-0 pt-0.75 wrap-anywhere">
					<h2 id="conflict-panel-title" className="text-body">
						Conflicts with {merge.into}
					</h2>
					<p className="mt-0.5 mb-0 text-ui text-muted-foreground">
						{counted(files.length, "file")} changed on both sides, as its agent's last status found
						{merge.head ? (
							<>
								{" "}
								on <code>{shortSha(merge.head)}</code>
							</>
						) : null}{" "}
						against {merge.into} at <code>{shortSha(merge.branchHead)}</code>.
						{moved ? " The change has moved since: its agent's next status checks it again." : null}
					</p>
				</div>
			</div>
			<ul className="m-0 list-none p-0">
				{shown.map((file) => (
					<ConflictedFile
						key={file}
						file={file}
						into={merge.into}
						touchedBy={(merge.touchedBy ?? []).filter((touched) => touched.file === file)}
						hunk={merge.hunks?.find((hunk) => hunk.file === file)}
						repo={repo}
						fileHref={fileHref}
					/>
				))}
			</ul>
			{files.length > shown.length ? (
				<p className="m-0 px-4 pb-3 text-ui text-muted-foreground">
					And {counted(files.length - shown.length, "more file")}.
				</p>
			) : null}
			{commands.length ? (
				<details className="disclosure border-t border-border bg-surface-2 [&_pre]:bg-card">
					<summary className="cursor-pointer px-4 py-2.5 text-ui font-semibold">What the agent will do</summary>
					<div className="grid gap-1.5 px-4 pb-3.5">
						<p className={LABEL}>
							Its next commands, for its own clone, where <code>origin</code> is the project and <code>fork</code> its
							copy. The agent resolves the conflict there; its new commit is reviewed and lands as usual.
						</p>
						<CopyBlock text={commands.join("\n")} label="Copy commands" />
						{then.length ? <p className={LABEL}>Then: {then.join(" ")}.</p> : null}
					</div>
				</details>
			) : null}
		</section>
	);
}
