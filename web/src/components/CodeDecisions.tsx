import { useEffect, useState } from "react";
import { api, type Slice } from "../api";
import type { CodeDecisionsProps, UnifiedCodeDiff } from "../dashboard-contract";
import "./CodeDecisions.css";

interface StoredDiff {
	key: string;
	loading: boolean;
	diff?: UnifiedCodeDiff;
	error?: string;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function needsHuman(slice: Slice): boolean {
	return slice.attention !== undefined;
}

function humanKey(slice: Slice): string {
	return JSON.stringify([slice.id, slice.attention, slice.lastFeedback, slice.reviewHead, slice.mergeBase]);
}

function ChangedFiles({ diff, label }: { diff: UnifiedCodeDiff; label: string }) {
	const omitted = new Set(diff.omitted);
	return (
		<div className="code-decisions__files" aria-label={`${label} changed files`}>
			<h4>Changed files ({diff.files.length})</h4>
			{diff.files.length > 0 ? (
				<ul>
					{diff.files.map((path) => (
						<li key={path}>
							<code>{path}</code>
							{omitted.has(path) ? <span className="code-decisions__omitted">Diff content omitted (size limit)</span> : null}
						</li>
					))}
				</ul>
			) : <p className="muted">No changed files.</p>}
			{diff.omitted.length > 0 ? (
				<p className="code-decisions__omission-note" role="note">
					Diff content for {diff.omitted.length} changed {diff.omitted.length === 1 ? "file was" : "files were"} omitted by output size limits; those paths are still included in the changed-file list above.
				</p>
			) : null}
		</div>
	);
}

export function CodeDecisions({ task, busy, onWaive }: CodeDecisionsProps) {
	const slices = Array.isArray(task.slices) ? task.slices : [];
	const humanSlices = slices.filter(needsHuman);
	const humanStateKey = JSON.stringify([task.id, humanSlices.map(humanKey)]);
	const [diffs, setDiffs] = useState<Record<string, StoredDiff>>({});
	const [diffRetry, setDiffRetry] = useState(0);
	const [reasons, setReasons] = useState<Record<string, string>>({});

	useEffect(() => {
		let active = true;
		const next: Record<string, StoredDiff> = {};
		for (const slice of humanSlices) next[slice.id] = { key: humanKey(slice), loading: true };
		setDiffs(next);
		for (const slice of humanSlices) {
			const key = humanKey(slice);
			void api.sliceDiff(task.id, slice.id).then((diff) => {
				if (active) setDiffs((current) => ({ ...current, [slice.id]: { key, loading: false, diff } }));
			}).catch((error: unknown) => {
				if (active) setDiffs((current) => ({ ...current, [slice.id]: { key, loading: false, error: message(error) } }));
			});
		}
		setReasons({});
		return () => { active = false; };
	}, [humanStateKey, diffRetry, task.id]);

	return (
		<section className="code-decisions" aria-label="Code decision details">
			{humanSlices.length > 0 ? (
				<section className="code-decisions__section card" aria-labelledby="code-human-title">
					<h2 id="code-human-title">Human review decisions</h2>
					<p className="muted">Each diff is the review commit for the slice compared with where that slice started.</p>
					{humanSlices.map((slice) => {
						const key = humanKey(slice);
						const result = diffs[slice.id]?.key === key ? diffs[slice.id] : null;
						const reason = reasons[slice.id] ?? "";
						const diffLoaded = !!result && !result.loading && result.error === undefined && !!result.diff;
						return (
							<article className="code-decisions__human" key={slice.id}>
								<div className="code-decisions__finding">
									<h3>{slice.title} <span className="muted">({slice.id})</span></h3>
									<h4>Finding</h4>
									<p>{slice.attention || "This slice needs a human decision."}</p>
									{slice.lastFeedback ? <><h4>Last reviewer feedback</h4><p>{slice.lastFeedback}</p></> : null}
									<label className="code-decisions__reason-label" htmlFor={`waiver-reason-${encodeURIComponent(slice.id)}`}>Reason for waiving human review</label>
									<textarea
										id={`waiver-reason-${encodeURIComponent(slice.id)}`}
										value={reason}
										onChange={(event) => setReasons((current) => ({ ...current, [slice.id]: event.target.value }))}
										rows={3}
										disabled={busy}
										placeholder="Explain why this slice may proceed without review quorum"
									/>
									<button type="button" disabled={busy || !diffLoaded || !reason.trim()} onClick={() => {
										if (!diffLoaded) return;
										onWaive(slice.id, reason.trim());
										setReasons((current) => ({ ...current, [slice.id]: "" }));
									}}>Waive review quorum</button>
									<p className="muted code-decisions__waiver-note">A waiver overrides review quorum only; the integration gate still applies.</p>
								</div>
								<div className="code-decisions__diff">
									<h4>Unified diff{slice.reviewHead ? <> · review commit <code>{slice.reviewHead}</code></> : " · current review commit"}</h4>
									{!result || result.loading ? <p className="muted" role="status">Loading slice diff…</p> : null}
									{result?.error ? <div className="code-decisions__error" role="alert"><p>Could not load this slice diff: {result.error}</p><button type="button" onClick={() => setDiffRetry((count) => count + 1)}>Retry diffs</button></div> : null}
									{result?.diff ? <>
										<p className="code-decisions__commits muted"><code>{result.diff.base}</code> → <code>{result.diff.head}</code></p>
										<ChangedFiles diff={result.diff} label={`${slice.title} slice diff`} />
										<pre className="code-decisions__code code-decisions__diff-text" tabIndex={0} role="region" aria-label={`Unified diff for slice ${slice.title}`}><code>{result.diff.unified || "(No changes in this diff.)"}</code></pre>
									</> : null}
								</div>
							</article>
						);
					})}
				</section>
			) : null}
		</section>
	);
}
