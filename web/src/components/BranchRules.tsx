import { type FormEvent, useEffect, useRef, useState } from "react";
import type { BranchRule, SavedMergeSettings, SettingsInput } from "../api";
import { branchRulesFrom, emptyRule, type RuleDraft, ruleDraftsFrom } from "../lib/branchRules";
import { useArrivals } from "../hooks/useArrivals";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import {
	COMMAND,
	REMOVE,
	RULE,
	SaveBar,
	SaveErrors,
	SETTINGS_FIELDS,
	SETTINGS_FORM,
	SettingField,
	SettingsSection,
} from "./MergeSettings";
import { BoxBody } from "./ui/box";
import { Button } from "./ui/button";
import { Collapse, Fold } from "./ui/collapse";
import { Input, Label, NativeSelect, Textarea } from "./ui/field";

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
	// A rule added after the page showed unfolds into place.
	const added = useArrivals(drafts.map((_, index) => String(index)));

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
		<form className={SETTINGS_FORM} onSubmit={submit}>
			<SettingsSection id="settings-branches" title="Branch rules">
				<BoxBody className={SETTINGS_FIELDS}>
					<p className="m-0 text-muted-foreground">
						Settings for other branches than {branch}, by name: feature/* for every feature branch, say. A field left
						blank keeps the repo's setting above, and follows it when it changes. The first rule that matches a branch
						is its rule; {branch} always has the repo's own.
					</p>
					{drafts.map((draft, index) => (
						<Collapse key={index} open appear={added(String(index))} className="-m-1">
							<div className="p-1">
								<BranchRuleFields
									draft={draft}
									index={index}
									busy={busy}
									edit={(patch) => edit(index, patch)}
									remove={() => remove(index)}
								/>
							</div>
						</Collapse>
					))}
					<div>
						<Button onClick={() => setDrafts((current) => [...current, emptyRule()])} disabled={busy}>
							Add a branch rule
						</Button>
					</div>
				</BoxBody>
			</SettingsSection>
			<SaveBar>
				<SaveErrors errors={errors} />
				{saved && !dirty ? <p className="mt-0 mb-2 animate-appear text-good">Branch rules saved.</p> : null}
				<Button type="submit" variant="go" disabled={busy || !dirty}>
					{busy ? "Saving…" : "Save branch rules"}
				</Button>
			</SaveBar>
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
// A branch rule's settings: four fields abreast, wrapping on narrow windows, their fields of one height on one line.
const GRID = "grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-end gap-x-4 gap-y-3";
const GRID_FIELD = "h-9 w-full";

/** One branch rule: the branches it matches and what it changes for them. Its own checks unfold as they're chosen. */
function BranchRuleFields({ draft, index, busy, edit, remove }: BranchRuleFieldsProps) {
	const these = draft.checks === "these";
	return (
		<fieldset className={cn(RULE, "gap-0")} disabled={busy}>
			<legend className="sr-only">Rule {index + 1}</legend>
			<SettingField>
				<Label htmlFor={`rule-pattern-${index}`}>Branches</Label>
				<Input
					id={`rule-pattern-${index}`}
					className={COMMAND}
					placeholder="feature/*"
					value={draft.pattern}
					onChange={(event) => edit({ pattern: event.target.value })}
				/>
			</SettingField>
			<div className={cn(GRID, "mt-2")}>
				<SettingField>
					<Label htmlFor={`rule-required-${index}`}>Required approvals</Label>
					<Input
						id={`rule-required-${index}`}
						className={GRID_FIELD}
						inputMode="numeric"
						placeholder="the repo's"
						value={draft.required}
						onChange={(event) => edit({ required: event.target.value })}
					/>
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-vetoes-${index}`}>Roles that can block</Label>
					<Input
						id={`rule-vetoes-${index}`}
						className={GRID_FIELD}
						placeholder="the repo's"
						value={draft.vetoes}
						onChange={(event) => edit({ vetoes: event.target.value })}
					/>
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-grants-${index}`}>Who may vote as them</Label>
					<Input
						id={`rule-grants-${index}`}
						className={GRID_FIELD}
						placeholder="person:* for people only"
						value={draft.grants}
						onChange={(event) => edit({ grants: event.target.value })}
					/>
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-checks-${index}`}>Checks</Label>
					<NativeSelect
						id={`rule-checks-${index}`}
						className={GRID_FIELD}
						value={draft.checks}
						onChange={(event) => edit({ checks: event.target.value as RuleDraft["checks"] })}
					>
						<option value="repo">The repo's</option>
						<option value="none">None</option>
						<option value="these">These</option>
					</NativeSelect>
				</SettingField>
			</div>
			<Fold open={these} className="-mx-1 -mb-1">
				<SettingField className="px-1 pt-2 pb-1">
					<Label htmlFor={`rule-verify-${index}`}>Its checks, one command a line</Label>
					<Textarea
						id={`rule-verify-${index}`}
						className={cn(COMMAND, "leading-[1.45]")}
						value={draft.verify}
						onChange={(event) => edit({ verify: event.target.value })}
					/>
				</SettingField>
			</Fold>
			<Button variant="link" className={cn(REMOVE, "mt-2")} onClick={remove}>
				Remove this rule
			</Button>
		</fieldset>
	);
}
