import type { UnifiedCodeDiff } from "../api";
import { parseUnifiedDiff, type FileDiff } from "../lib/diff";
import { shortSha, type Change } from "../lib/model";
import { Icon } from "./Icon";
import "./FilesChanged.css";

export interface DiffState {
	loading: boolean;
	diff?: UnifiedCodeDiff;
	error?: string;
}

function FileBlock({ file, outside }: { file: FileDiff; outside: boolean }) {
	return (
		<details className="file-diff box" open>
			<summary className="file-diff__header">
				<Icon name="chevron" size={14} className="file-diff__chevron" />
				<code className="file-diff__path">{file.path}</code>
				{file.status !== "modified" ? <span className={`pill pill--${file.status === "added" ? "good" : "bad"}`}>{file.status}</span> : null}
				{outside ? <span className="pill pill--warn">outside its claim</span> : null}
				<span className="file-diff__stats">
					<span className="tone-good">+{file.additions}</span> <span className="tone-bad">−{file.deletions}</span>
				</span>
			</summary>
			<div className="file-diff__scroll" tabIndex={0} role="region" aria-label={`Changes to ${file.path}`}>
				<table className="file-diff__table">
					<tbody>
						{file.lines.map((line, index) =>
							line.type === "hunk" ? (
								<tr key={index} className="file-diff__hunk">
									<td colSpan={3}>{line.text}</td>
								</tr>
							) : (
								<tr key={index} className={`file-diff__line file-diff__line--${line.type}`}>
									<td className="file-diff__no" aria-hidden="true">{line.oldNo ?? ""}</td>
									<td className="file-diff__no" aria-hidden="true">{line.newNo ?? ""}</td>
									<td className="file-diff__code">
										<span className="sr-only">{line.type === "add" ? "added: " : line.type === "del" ? "removed: " : ""}</span>
										<span aria-hidden="true" className="file-diff__sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
										{line.text}
									</td>
								</tr>
							),
						)}
					</tbody>
				</table>
			</div>
		</details>
	);
}

/** The Files changed tab: the line-by-line diff, or the list of files while it loads or if it can't. */
export function FilesChanged({ change, diff, onRetry }: { change: Change; diff?: DiffState; onRetry?(): void }) {
	const outside = new Set(change.outOfLane ?? []);
	const parsed = diff?.diff ? parseUnifiedDiff(diff.diff.unified) : [];
	const omitted = new Set(diff?.diff?.omitted ?? []);
	const files = diff?.diff?.files ?? change.touched;
	const additions = parsed.reduce((sum, file) => sum + file.additions, 0);
	const deletions = parsed.reduce((sum, file) => sum + file.deletions, 0);

	return (
		<section className="files-changed" aria-labelledby="files-changed-title">
			<div className="files-changed__summary">
				<h2 id="files-changed-title">
					{files.length} {files.length === 1 ? "file" : "files"} changed
				</h2>
				{diff?.diff ? (
					<span className="muted">
						<span className="tone-good">+{additions}</span> <span className="tone-bad">−{deletions}</span> · <code>{shortSha(diff.diff.base)}</code> → <code>{shortSha(diff.diff.head)}</code>
					</span>
				) : change.head ? (
					<span className="muted">
						as of <code>{shortSha(change.head)}</code>
					</span>
				) : null}
			</div>

			{outside.size ? (
				<div className="callout callout--warn">
					<Icon name="alert" className="tone-warn" />
					<div>
						<strong>Edits outside its claim</strong>
						<p>
							This change touches {[...outside].map((p, i) => <span key={p}>{i ? ", " : ""}<code>{p}</code></span>)}, outside {change.owns.join(", ") || "its claim"}.
						</p>
					</div>
				</div>
			) : null}

			{diff?.loading ? (
				<p className="muted" role="status">
					Loading the changes…
				</p>
			) : null}
			{diff?.error ? (
				<div className="callout callout--bad" role="alert">
					<Icon name="x" className="tone-bad" />
					<div>
						<strong>Couldn't load the diff</strong>
						<p>{diff.error}</p>
						{onRetry ? (
							<button type="button" onClick={onRetry} style={{ marginTop: 8 }}>
								Try again
							</button>
						) : null}
					</div>
				</div>
			) : null}

			{parsed.map((file) => (
				<FileBlock key={file.path} file={file} outside={outside.has(file.path)} />
			))}

			{diff?.diff && omitted.size ? (
				<div className="box">
					<div className="box__header">
						<strong>Too large to show</strong>
					</div>
					<ul className="files-changed__list">
						{[...omitted].map((path) => (
							<li key={path}>
								<Icon name="file" size={14} className="muted" /> <code>{path}</code>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{!diff?.diff ? (
				files.length ? (
					<div className="box">
						<ul className="files-changed__list">
							{files.map((path) => (
								<li key={path}>
									<Icon name="file" size={14} className="muted" /> <code>{path}</code>
									{outside.has(path) ? <span className="pill pill--warn">outside its claim</span> : null}
								</li>
							))}
						</ul>
					</div>
				) : (
					<div className="box empty">
						<Icon name="file" size={28} className="muted" />
						<h2>No files changed yet</h2>
						<p>Files appear here once the agent pushes its work.</p>
					</div>
				)
			) : null}
		</section>
	);
}
