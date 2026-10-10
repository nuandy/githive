import { type FormEvent, useEffect, useRef, useState } from "react";
import type { RepoSnapshot, SavedMergeSettings, SettingsInput } from "../api";
import { blockingRolesOf, draftFrom, type MergeDraft, settingsFrom } from "../lib/mergeSettings";
import { messageOf } from "../lib/errors";
import { Icon } from "./Icon";
import { MergeChecks } from "./MergeChecks";
import "./RepoSettings.css";

export interface MergeSettingsProps {
	snapshot: Pick<RepoSnapshot, "policy" | "verify" | "branch" | "skipChecks">;
	/** The settings tool, for this repo. */
	save(settings: SettingsInput): Promise<SavedMergeSettings>;
	/** After a save: refresh what the page shows. */
	onSaved?(): void;
}

/** What each section of the form gets: the draft, a way to change it, and whether a save is under way. */
export interface DraftSectionProps {
	draft: MergeDraft;
	update(patch: Partial<MergeDraft>): void;
	busy: boolean;
}

type PathRuleDraft = MergeDraft["escalate"][number];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * How changes merge, for the repo's admins to change: the review policy, who may block, stricter rules for
 * paths, and the checks.
 */
export function MergeSettings({ snapshot, save, onSaved }: MergeSettingsProps) {
	const fresh = draftFrom(snapshot.policy, snapshot.verify, snapshot.skipChecks);
	const freshKey = JSON.stringify(fresh);
	const [draft, setDraft] = useState<MergeDraft>(fresh);
	const [baseKey, setBaseKey] = useState(freshKey);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const [saved, setSaved] = useState<SavedMergeSettings | null>(null);
	const dirty = JSON.stringify(draft) !== baseKey;
	const branch = snapshot.branch ?? "main";

	// If someone else changed the settings, follow them unless this form has edits of its own.
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

	const submit = async (event: FormEvent<HTMLFormElement>) => {
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
			const next = draftFrom(done.policy, done.verify, done.skipChecks);
			setDraft(next);
			setBaseKey(JSON.stringify(next));
			setSaved(done);
			onSaved?.();
		} catch (err) {
			setErrors([messageOf(err)]);
		} finally {
			setBusy(false);
		}
	};

	const discard = () => {
		setDraft(JSON.parse(freshKey) as MergeDraft);
		setBaseKey(freshKey);
		setErrors([]);
	};

	return (
		<form className="repo-settings__form" onSubmit={submit}>
			<ReviewPolicy draft={draft} update={update} busy={busy} />
			<PathRules draft={draft} update={update} busy={busy} />
			<MergeChecks draft={draft} update={update} busy={busy} branch={branch} />
			<div className="repo-settings__save">
				<SaveErrors errors={errors} />
				{saved ? <SavedNotice saved={saved} /> : null}
				<div className="repo-settings__buttons">
					<button type="button" disabled={busy || !dirty} onClick={discard}>
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

function ReviewPolicy({ draft, update, busy }: DraftSectionProps) {
	return (
		<section className="box" aria-labelledby="settings-review">
			<div className="box__header">
				<h2 id="settings-review">Review policy</h2>
			</div>
			<div className="box__body repo-settings__fields">
				<div className="repo-settings__field">
					<label htmlFor="settings-required">Required approvals</label>
					<input
						id="settings-required"
						type="number"
						min={0}
						inputMode="numeric"
						value={draft.required}
						onChange={(event) => update({ required: event.target.value })}
						disabled={busy}
					/>
					<p className="muted">
						From reviewers other than the change's author. 0 merges a change on its checks alone (a role that can block
						must still approve).
					</p>
				</div>
				<div className="repo-settings__field">
					<label htmlFor="settings-vetoes">Roles that can block any change</label>
					<input
						id="settings-vetoes"
						value={draft.vetoes}
						onChange={(event) => update({ vetoes: event.target.value })}
						placeholder="security"
						autoComplete="off"
						spellCheck={false}
						disabled={busy}
					/>
					<p className="muted">
						Comma-separated, like security or api-design. Each must approve, and one rejection blocks the merge.
					</p>
				</div>
				<RoleGrants draft={draft} update={update} busy={busy} />
			</div>
		</section>
	);
}

/** Who may vote as each role that can block, shown once there is such a role. */
function RoleGrants({ draft, update, busy }: DraftSectionProps) {
	const blocking = blockingRolesOf(draft);
	if (!blocking.length) return null;
	return (
		<fieldset className="repo-settings__roles" disabled={busy}>
			<legend>Who may vote as each role that can block</legend>
			<p className="muted">
				Agent names, person:* for people, @org/team, or githive for GitHive's reviewers. Blank: people and GitHive's
				reviewers.
			</p>
			{blocking.map((role) => (
				<div key={role} className="repo-settings__field">
					<label htmlFor={`grant-${role}`}>
						<code>{role}</code>
					</label>
					<input
						id={`grant-${role}`}
						value={draft.grants[role] ?? ""}
						onChange={(event) => update({ grants: { ...draft.grants, [role]: event.target.value } })}
						placeholder="person:*, githive"
						autoComplete="off"
						spellCheck={false}
					/>
				</div>
			))}
		</fieldset>
	);
}

function PathRules({ draft, update, busy }: DraftSectionProps) {
	const changeRule = (index: number, patch: Partial<PathRuleDraft>) => {
		const escalate = draft.escalate.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule));
		update({ escalate });
	};
	const removeRule = (index: number) =>
		update({ escalate: draft.escalate.filter((_, ruleIndex) => ruleIndex !== index) });
	const addRule = () => update({ escalate: [...draft.escalate, { paths: "", required: "", vetoes: "" }] });

	return (
		<section className="box" aria-labelledby="settings-escalate">
			<div className="box__header">
				<h2 id="settings-escalate">Stricter rules for paths</h2>
			</div>
			<div className="box__body repo-settings__fields">
				<p className="muted">
					A change touching any of these paths needs at least this many approvals, and these roles can block it.
				</p>
				{draft.escalate.map((rule, index) => (
					<PathRule
						key={index}
						rule={rule}
						index={index}
						busy={busy}
						change={(patch) => changeRule(index, patch)}
						remove={() => removeRule(index)}
					/>
				))}
				<div>
					<button type="button" onClick={addRule} disabled={busy}>
						<Icon name="plus" />
						Add a rule
					</button>
				</div>
			</div>
		</section>
	);
}

interface PathRuleProps {
	rule: PathRuleDraft;
	index: number;
	busy: boolean;
	change(patch: Partial<PathRuleDraft>): void;
	remove(): void;
}

function PathRule({ rule, index, busy, change, remove }: PathRuleProps) {
	return (
		<fieldset className="repo-settings__rule" disabled={busy}>
			<legend>Rule {index + 1}</legend>
			<div className="repo-settings__field">
				<label htmlFor={`rule-${index}-paths`}>Paths</label>
				<textarea
					id={`rule-${index}-paths`}
					rows={3}
					value={rule.paths}
					onChange={(event) => change({ paths: event.target.value })}
					placeholder={"package.json\n.github/"}
					spellCheck={false}
				/>
			</div>
			<div className="repo-settings__rule-grid">
				<div className="repo-settings__field">
					<label htmlFor={`rule-${index}-required`}>Approvals</label>
					<input
						id={`rule-${index}-required`}
						type="number"
						min={0}
						inputMode="numeric"
						value={rule.required}
						onChange={(event) => change({ required: event.target.value })}
						placeholder="same"
					/>
				</div>
				<div className="repo-settings__field">
					<label htmlFor={`rule-${index}-vetoes`}>Can block</label>
					<input
						id={`rule-${index}-vetoes`}
						value={rule.vetoes}
						onChange={(event) => change({ vetoes: event.target.value })}
						placeholder="security"
						autoComplete="off"
						spellCheck={false}
					/>
				</div>
			</div>
			<button type="button" className="link repo-settings__remove" onClick={remove}>
				Remove rule {index + 1}
			</button>
		</fieldset>
	);
}

function SaveErrors({ errors }: { errors: string[] }) {
	if (!errors.length) return null;
	return (
		<ul className="repo-settings__errors" role="alert">
			{errors.map((error) => (
				<li key={error}>{error}</li>
			))}
		</ul>
	);
}

/** What the last save set, and any warnings the server gave with it. */
function SavedNotice({ saved }: { saved: SavedMergeSettings }) {
	const checks = saved.verify.length ? ` and pass ${plural(saved.verify.length, "check")}` : ", with no checks";
	return (
		<div role="status">
			<p className="tone-good repo-settings__saved">
				<Icon name="check" /> Saved. Merges from now on need {plural(saved.policy.required, "approval")}
				{checks}.
			</p>
			{(saved.warnings ?? []).map((warning) => (
				<p key={warning} className="repo-settings__saved muted">
					<Icon name="alert" /> {warning}
				</p>
			))}
		</div>
	);
}
