import { useEffect, useRef, useState } from "react";
import type { RepoSnapshot, SavedMergeSettings, SettingsInput } from "../api";
import { blockingRolesOf, draftFrom, type MergeDraft, settingsFrom } from "../lib/mergeSettings";
import { messageOf } from "./Confirm";
import { Icon } from "./Icon";
import "./RepoSettings.css";

export interface MergeSettingsProps {
	snapshot: Pick<RepoSnapshot, "policy" | "verify" | "branch">;
	/** The settings tool, for this repo. */
	save(settings: SettingsInput): Promise<SavedMergeSettings>;
	/** After a save: refresh what the page shows. */
	onSaved?(): void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How changes merge, for the repo's admins to change: the review policy, who may block, stricter rules for paths, and the checks. */
export function MergeSettings({ snapshot, save, onSaved }: MergeSettingsProps) {
	const fresh = draftFrom(snapshot.policy, snapshot.verify);
	const freshKey = JSON.stringify(fresh);
	const [draft, setDraft] = useState<MergeDraft>(fresh);
	const [baseKey, setBaseKey] = useState(freshKey);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const [saved, setSaved] = useState<SavedMergeSettings | null>(null);
	const dirty = JSON.stringify(draft) !== baseKey;
	const branch = snapshot.branch ?? "main";

	// Someone else changed the settings: follow them, unless this form has edits of its own.
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	useEffect(() => {
		if (dirtyRef.current) return;
		setDraft(JSON.parse(freshKey) as MergeDraft);
		setBaseKey(freshKey);
	}, [freshKey]);

	const update = (patch: Partial<MergeDraft>) => {
		setSaved(null);
		setDraft((current) => ({ ...current, ...patch }));
	};
	const blocking = blockingRolesOf(draft);

	return (
		<form
			className="repo-settings__form"
			onSubmit={async (event) => {
				event.preventDefault();
				const result = settingsFrom(draft);
				if (!result.settings) {
					setErrors(result.errors);
					return;
				}
				setBusy(true);
				setErrors([]);
				try {
					const done = await save(result.settings);
					const next = draftFrom(done.policy, done.verify);
					setDraft(next);
					setBaseKey(JSON.stringify(next));
					setSaved(done);
					onSaved?.();
				} catch (err) {
					setErrors([messageOf(err)]);
				} finally {
					setBusy(false);
				}
			}}
		>
			<section className="box" aria-labelledby="settings-review">
				<div className="box__header">
					<h2 id="settings-review">Review policy</h2>
				</div>
				<div className="box__body repo-settings__fields">
					<div className="repo-settings__field">
						<label htmlFor="settings-required">Required approvals</label>
						<input id="settings-required" type="number" min={0} inputMode="numeric" value={draft.required} onChange={(e) => update({ required: e.target.value })} disabled={busy} />
						<p className="muted">From reviewers other than the change's author. 0 merges a change on its checks alone (a role that can block must still approve).</p>
					</div>
					<div className="repo-settings__field">
						<label htmlFor="settings-vetoes">Roles that can block any change</label>
						<input id="settings-vetoes" value={draft.vetoes} onChange={(e) => update({ vetoes: e.target.value })} placeholder="security" autoComplete="off" spellCheck={false} disabled={busy} />
						<p className="muted">Comma-separated, like security or api-design. Each must approve, and one rejection blocks the merge.</p>
					</div>
					{blocking.length ? (
						<fieldset className="repo-settings__roles" disabled={busy}>
							<legend>Who may vote as each role that can block</legend>
							<p className="muted">Agent names, person:* for people, @org/team, or githive for GitHive's reviewers. Blank: people and GitHive's reviewers.</p>
							{blocking.map((role) => (
								<div key={role} className="repo-settings__field">
									<label htmlFor={`grant-${role}`}>
										<code>{role}</code>
									</label>
									<input
										id={`grant-${role}`}
										value={draft.grants[role] ?? ""}
										onChange={(e) => update({ grants: { ...draft.grants, [role]: e.target.value } })}
										placeholder="person:*, githive"
										autoComplete="off"
										spellCheck={false}
									/>
								</div>
							))}
						</fieldset>
					) : null}
				</div>
			</section>

			<section className="box" aria-labelledby="settings-escalate">
				<div className="box__header">
					<h2 id="settings-escalate">Stricter rules for paths</h2>
				</div>
				<div className="box__body repo-settings__fields">
					<p className="muted">A change touching any of these paths needs at least this many approvals, and these roles can block it.</p>
					{draft.escalate.map((row, index) => {
						const set = (patch: Partial<typeof row>) => update({ escalate: draft.escalate.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
						return (
							<fieldset key={index} className="repo-settings__rule" disabled={busy}>
								<legend>Rule {index + 1}</legend>
								<div className="repo-settings__field">
									<label htmlFor={`rule-${index}-paths`}>Paths</label>
									<textarea id={`rule-${index}-paths`} rows={3} value={row.paths} onChange={(e) => set({ paths: e.target.value })} placeholder={"package.json\n.github/"} spellCheck={false} />
								</div>
								<div className="repo-settings__rule-grid">
									<div className="repo-settings__field">
										<label htmlFor={`rule-${index}-required`}>Approvals</label>
										<input id={`rule-${index}-required`} type="number" min={0} inputMode="numeric" value={row.required} onChange={(e) => set({ required: e.target.value })} placeholder="same" />
									</div>
									<div className="repo-settings__field">
										<label htmlFor={`rule-${index}-vetoes`}>Can block</label>
										<input id={`rule-${index}-vetoes`} value={row.vetoes} onChange={(e) => set({ vetoes: e.target.value })} placeholder="security" autoComplete="off" spellCheck={false} />
									</div>
								</div>
								<button type="button" className="link repo-settings__remove" onClick={() => update({ escalate: draft.escalate.filter((_, i) => i !== index) })}>
									Remove rule {index + 1}
								</button>
							</fieldset>
						);
					})}
					<div>
						<button type="button" onClick={() => update({ escalate: [...draft.escalate, { paths: "", required: "", vetoes: "" }] })} disabled={busy}>
							<Icon name="plus" />
							Add a rule
						</button>
					</div>
				</div>
			</section>

			<section className="box" aria-labelledby="settings-checks">
				<div className="box__header">
					<h2 id="settings-checks">Merge checks</h2>
				</div>
				<div className="box__body repo-settings__fields">
					<p className="muted">
						Commands that must pass on a change merged into {branch} before it lands, run by GitHive in its own container. None: a change merges once approved, and no container runs.
					</p>
					{draft.verify.map((command, index) => (
						<div key={index} className="repo-settings__add">
							<label className="sr-only" htmlFor={`check-${index}`}>
								Check {index + 1}
							</label>
							<input
								id={`check-${index}`}
								className="repo-settings__command"
								value={command}
								onChange={(e) => update({ verify: draft.verify.map((c, i) => (i === index ? e.target.value : c)) })}
								placeholder="npm test"
								spellCheck={false}
								disabled={busy}
							/>
							<button type="button" className="link" onClick={() => update({ verify: draft.verify.filter((_, i) => i !== index) })} disabled={busy} aria-label={`Remove check ${index + 1}`}>
								Remove
							</button>
						</div>
					))}
					<div>
						<button type="button" onClick={() => update({ verify: [...draft.verify, ""] })} disabled={busy}>
							<Icon name="plus" />
							Add a check
						</button>
					</div>
				</div>
			</section>

			<div className="repo-settings__save">
				{errors.length ? (
					<ul className="repo-settings__errors" role="alert">
						{errors.map((error) => (
							<li key={error}>{error}</li>
						))}
					</ul>
				) : null}
				{saved ? (
					<div role="status">
						<p className="tone-good repo-settings__saved">
							<Icon name="check" /> Saved. Merges from now on need {plural(saved.policy.required, "approval")}
							{saved.verify.length ? ` and pass ${plural(saved.verify.length, "check")}` : ", with no checks"}.
						</p>
						{(saved.warnings ?? []).map((warning) => (
							<p key={warning} className="repo-settings__saved muted">
								<Icon name="alert" /> {warning}
							</p>
						))}
					</div>
				) : null}
				<div className="repo-settings__buttons">
					<button
						type="button"
						disabled={busy || !dirty}
						onClick={() => {
							setDraft(JSON.parse(freshKey) as MergeDraft);
							setBaseKey(freshKey);
							setErrors([]);
						}}
					>
						Discard edits
					</button>
					<button type="submit" className="primary" disabled={busy || !dirty}>
						{busy ? "Saving…" : "Save settings"}
					</button>
				</div>
			</div>
		</form>
	);
}
