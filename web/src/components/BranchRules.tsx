import { type FormEvent, useEffect, useRef, useState } from "react";
import type { BranchRule, SavedMergeSettings, SettingsInput } from "../api";
import { branchRulesFrom, emptyRule, type RuleDraft, ruleDraftsFrom } from "../lib/branchRules";
import { messageOf } from "./Confirm";
import "./RepoSettings.css";
import "./BranchRules.css";

export interface BranchRulesProps {
	/** The project's branch, which always has the repo's own settings. */
	branch: string;
	rules: BranchRule[] | undefined;
	/** The settings tool, for this repo. */
	save(settings: SettingsInput): Promise<SavedMergeSettings>;
	onSaved?(): void;
}

/** Other branches' settings, for admins. Each rule matches branches by pattern and changes only what it sets. */
export function BranchRules({ branch, rules, save, onSaved }: BranchRulesProps) {
	const freshKey = JSON.stringify(ruleDraftsFrom(rules));
	const [drafts, setDrafts] = useState<RuleDraft[]>(() => JSON.parse(freshKey) as RuleDraft[]);
	const [baseKey, setBaseKey] = useState(freshKey);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const [saved, setSaved] = useState(false);
	const dirty = JSON.stringify(drafts) !== baseKey;

	// If someone else changed the rules, follow them unless this form has edits of its own.
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	useEffect(() => {
		if (dirtyRef.current) return;
		setDrafts(JSON.parse(freshKey) as RuleDraft[]);
		setBaseKey(freshKey);
	}, [freshKey]);

	const edit = (index: number, patch: Partial<RuleDraft>) => {
		setSaved(false);
		setDrafts((current) => current.map((draft, ruleIndex) => (ruleIndex === index ? { ...draft, ...patch } : draft)));
	};
	const remove = (index: number) => setDrafts((current) => current.filter((_, ruleIndex) => ruleIndex !== index));

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const result = branchRulesFrom(drafts);
		if (!result.rules) return setErrors(result.errors);
		setBusy(true);
		setErrors([]);
		try {
			const done = await save({ branch_rules: result.rules });
			const next = ruleDraftsFrom(done.branchRules);
			setDrafts(next);
			setBaseKey(JSON.stringify(next));
			setSaved(true);
			onSaved?.();
		} catch (err) {
			setErrors([messageOf(err)]);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="repo-settings__form" onSubmit={submit}>
			<section className="box" aria-labelledby="settings-branches">
				<div className="box__header">
					<h2 id="settings-branches">Branch rules</h2>
				</div>
				<div className="box__body repo-settings__fields">
					<p className="muted">
						Settings for other branches than {branch}, by name: feature/* for every feature branch, say. A field left
						blank keeps the repo's setting above, and follows it when it changes. The first rule that matches a branch
						is its rule; {branch} always has the repo's own.
					</p>
					{drafts.map((draft, index) => (
						<BranchRuleFields
							key={index}
							draft={draft}
							index={index}
							busy={busy}
							edit={(patch) => edit(index, patch)}
							remove={() => remove(index)}
						/>
					))}
					<div>
						<button type="button" onClick={() => setDrafts((current) => [...current, emptyRule()])} disabled={busy}>
							Add a branch rule
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
				{saved && !dirty ? <p className="tone-good">Branch rules saved.</p> : null}
				<button type="submit" className="primary" disabled={busy || !dirty}>
					{busy ? "Saving…" : "Save branch rules"}
				</button>
			</div>
		</form>
	);
}

interface BranchRuleFieldsProps {
	draft: RuleDraft;
	index: number;
	busy: boolean;
	edit(patch: Partial<RuleDraft>): void;
	remove(): void;
}

/** One branch rule: the branches it matches and what it changes for them. */
function BranchRuleFields({ draft, index, busy, edit, remove }: BranchRuleFieldsProps) {
	return (
		<fieldset className="repo-settings__rule" disabled={busy}>
			<legend className="sr-only">Rule {index + 1}</legend>
			<div className="repo-settings__field">
				<label htmlFor={`rule-pattern-${index}`}>Branches</label>
				<input
					id={`rule-pattern-${index}`}
					className="repo-settings__command"
					placeholder="feature/*"
					value={draft.pattern}
					onChange={(event) => edit({ pattern: event.target.value })}
				/>
			</div>
			<div className="branch-rule__grid">
				<div className="repo-settings__field">
					<label htmlFor={`rule-required-${index}`}>Required approvals</label>
					<input
						id={`rule-required-${index}`}
						inputMode="numeric"
						placeholder="the repo's"
						value={draft.required}
						onChange={(event) => edit({ required: event.target.value })}
					/>
				</div>
				<div className="repo-settings__field">
					<label htmlFor={`rule-vetoes-${index}`}>Roles that can block</label>
					<input
						id={`rule-vetoes-${index}`}
						placeholder="the repo's"
						value={draft.vetoes}
						onChange={(event) => edit({ vetoes: event.target.value })}
					/>
				</div>
				<div className="repo-settings__field">
					<label htmlFor={`rule-grants-${index}`}>Who may vote as them</label>
					<input
						id={`rule-grants-${index}`}
						placeholder="person:* for people only"
						value={draft.grants}
						onChange={(event) => edit({ grants: event.target.value })}
					/>
				</div>
				<div className="repo-settings__field">
					<label htmlFor={`rule-checks-${index}`}>Checks</label>
					<select
						id={`rule-checks-${index}`}
						value={draft.checks}
						onChange={(event) => edit({ checks: event.target.value as RuleDraft["checks"] })}
					>
						<option value="repo">The repo's</option>
						<option value="none">None</option>
						<option value="these">These</option>
					</select>
				</div>
			</div>
			{draft.checks === "these" ? (
				<div className="repo-settings__field">
					<label htmlFor={`rule-verify-${index}`}>Its checks, one command a line</label>
					<textarea
						id={`rule-verify-${index}`}
						className="repo-settings__command"
						value={draft.verify}
						onChange={(event) => edit({ verify: event.target.value })}
					/>
				</div>
			) : null}
			<button type="button" className="link repo-settings__remove" onClick={remove}>
				Remove this rule
			</button>
		</fieldset>
	);
}
