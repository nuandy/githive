import type { MergeCheck, TouchedBy } from "../api";
import { shortSha } from "../lib/model";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { CopyBlock } from "./CopyBlock";
import { Icon } from "./Icon";
import "./ConflictPanel.css";

// A change's conflict with its branch, as the agent's last status found it: the files changed on both sides, who
// changed each since the change left the branch, the conflict markers, and the commands the agent runs next. People
// can't resolve it from here; the agent does, in its clone, and the result is reviewed and merged as before.

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
			{touched.intent ? <span className="muted"> · “{touched.intent}”</span> : null}{" "}
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
}: {
	file: string;
	into: string;
	touchedBy: TouchedBy[];
	hunk: Hunk | undefined;
	repo: string;
}) {
	return (
		<li className="conflict-panel__file">
			<h3 className="conflict-panel__name">
				<Icon name="file" size={13} className="muted" />
				<code>{file}</code>
			</h3>
			{touchedBy.length ? (
				<>
					<p className="muted conflict-panel__label">Changed on {into} since this change left it, by:</p>
					<ul className="conflict-panel__changed">
						{touchedBy.map((touched) => (
							<ChangedBy key={touched.commit} touched={touched} repo={repo} />
						))}
					</ul>
				</>
			) : (
				<p className="muted conflict-panel__label">Who changed it on {into} wasn't found.</p>
			)}
			{hunk ? (
				<figure className={`conflict-panel__hunk${hunk.truncated ? " conflict-panel__hunk--cut" : ""}`}>
					<pre tabIndex={0}>
						<code>{hunk.content}</code>
					</pre>
					{hunk.truncated ? (
						<figcaption className="conflict-panel__cut">
							Cut at 4 KB: the whole file is in the agent's clone.
						</figcaption>
					) : null}
				</figure>
			) : null}
		</li>
	);
}

/** The conflict panel, when the change's last merge check found conflicts; nothing otherwise. */
export function ConflictPanel({ merge, head, repo }: { merge: MergeCheck; head?: string | null; repo: string }) {
	const files = merge.conflicts ?? [];
	if (merge.clean || !files.length) return null;
	// The check is kept until the agent asks again, so it may be of an older push.
	const moved = !!head && !!merge.head && merge.head !== head;
	const shown = files.slice(0, FILES_SHOWN);
	return (
		<section className="conflict-panel" aria-labelledby="conflict-panel-title">
			<div className="conflict-panel__head">
				<span className="conflict-panel__icon" aria-hidden="true">
					<Icon name="conflict" />
				</span>
				<div className="conflict-panel__summary">
					<h2 id="conflict-panel-title">Conflicts with {merge.into}</h2>
					<p className="muted">
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
			<ul className="conflict-panel__files">
				{shown.map((file) => (
					<ConflictedFile
						key={file}
						file={file}
						into={merge.into}
						touchedBy={(merge.touchedBy ?? []).filter((touched) => touched.file === file)}
						hunk={merge.hunks?.find((hunk) => hunk.file === file)}
						repo={repo}
					/>
				))}
			</ul>
			{files.length > shown.length ? (
				<p className="muted conflict-panel__more">And {counted(files.length - shown.length, "more file")}.</p>
			) : null}
			{merge.fix?.length ? (
				<div className="conflict-panel__fix">
					<h3>The agent's next commands</h3>
					<p className="muted">
						For its own clone, where <code>origin</code> is the project and <code>fork</code> its copy. The agent
						resolves the conflict there; its new commit is reviewed and merged as usual.
					</p>
					<CopyBlock text={merge.fix.join("\n")} label="Copy commands" />
				</div>
			) : null}
		</section>
	);
}
