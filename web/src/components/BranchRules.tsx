import { type FormEvent, useState } from "react";
import { useArrivals } from "../hooks/useArrivals";
import { useHeldDraft } from "../hooks/useHeldDraft";
import { branchRuleProblems, branchRulesFrom, emptyRule, type RuleDraft, ruleDraftsFrom } from "../lib/branchRules";
import { messageOf } from "../lib/errors";
import { counted } from "../lib/plural";
import { draftKey } from "../lib/settingsDrafts";
import { holderLabel, resolveHolder, roleProblem, type TokenOption, textOf, tokensOf } from "../lib/tokens";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import type { SettingsContext } from "./MergeSettings";
import {
	COMMAND,
	type FieldProblem,
	problemsFor,
	REMOVE,
	RULE,
	type Said,
	saveBarSays,
	savedStatus,
	SETTINGS_FIELDS,
	SettingField,
	SettingsPart,
} from "./SettingsParts";
import { Button } from "./ui/button";
import { Collapse, Fold } from "./ui/collapse";
import { Input, Label, NativeSelect, Textarea } from "./ui/field";
import { SaveBar } from "./ui/save-bar";
import { TokenInput } from "./ui/token-input";

const rulesDiffer = (a: RuleDraft[], b: RuleDraft[]) => JSON.stringify(a) !== JSON.stringify(b);

/**
 * Other branches' settings, for admins. Each rule matches branches by pattern and changes only what it sets. The
 * rules are one draft, held for the session, saved together.
 */
export function BranchRulesSection({ repo, branch, snapshot, save, onSaved, drafts, options }: SettingsContext) {
	const held = useHeldDraft(drafts, draftKey(repo, "branch-rules"), ruleDraftsFrom(snapshot.branchRules), rulesDiffer);
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const { draft: rules, base } = held;
	const problems = tried ? branchRuleProblems(rules) : [];

	const change = (next: (current: RuleDraft[]) => RuleDraft[]) => {
		setSaid(null);
		held.edit(next);
	};
	const edit = (index: number, patch: Partial<RuleDraft>) =>
		change((current) => current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)));
	const remove = (index: number) => change((current) => current.filter((_, ruleIndex) => ruleIndex !== index));
	// A rule added after the page showed unfolds into place.
	const added = useArrivals(rules.map((_, index) => String(index)));

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setTried(true);
		const result = branchRulesFrom(rules);
		if (!result.rules) return;
		setBusy(true);
		setSaid(null);
		try {
			const done = await save({ branch_rules: result.rules });
			held.saved(ruleDraftsFrom(done.branchRules));
			setTried(false);
			const count = done.branchRules?.length ?? 0;
			setSaid({
				saved: savedStatus(count ? `Saved. ${counted(count, "branch rule")} from now on.` : "Saved. No branch rules."),
			});
			onSaved?.();
		} catch (err) {
			setSaid({ failed: messageOf(err) });
		} finally {
			setBusy(false);
		}
	};
	const discard = () => {
		held.discard();
		setTried(false);
		setSaid(null);
	};

	return (
		<form className="grid gap-4" onSubmit={submit} noValidate>
			<SettingsPart
				id="settings-branch-rules"
				title="Branch rules"
				description={
					`Rules for branches other than ${branch}, matched by name: feature/*, for example, covers every feature ` +
					`branch. A field left blank uses the repo's setting, and follows it when that changes. A branch follows ` +
					`the first rule that matches it; ${branch} always uses the repo's own settings.`
				}
			>
				<div className={cn(SETTINGS_FIELDS, "px-0.5 py-4")}>
					{rules.length ? null : (
						<p className="m-0 text-muted-foreground">No branch rules: every branch has the repo's settings.</p>
					)}
					{rules.map((rule, index) => (
						<Collapse key={index} open appear={added(String(index))} className="-m-1">
							<div className="p-1">
								<BranchRuleFields
									draft={rule}
									index={index}
									busy={busy}
									problems={problems}
									options={options}
									edit={(patch) => edit(index, patch)}
									remove={() => remove(index)}
								/>
							</div>
						</Collapse>
					))}
					<div>
						<Button onClick={() => change((current) => [...current, emptyRule()])} disabled={busy}>
							<Icon name="plus" />
							Add a branch rule
						</Button>
					</div>
				</div>
			</SettingsPart>
			<SaveBar {...saveBarSays(said, problems)} dirty={rulesDiffer(rules, base)} busy={busy} onDiscard={discard} />
		</form>
	);
}

interface BranchRuleFieldsProps {
	draft: RuleDraft;
	index: number;
	busy: boolean;
	problems: FieldProblem[];
	options: { roles: TokenOption[]; holders: TokenOption[] };
	edit(patch: Partial<RuleDraft>): void;
	remove(): void;
}

// A branch rule's settings, two abreast (one under another on a narrow window), their fields one height.
const GRID =
	"grid grid-cols-2 items-start gap-x-4 gap-y-3 to-640:grid-cols-1 [&_[data-slot=input]]:h-9.5 [&_[data-slot=native-select]]:h-9.5";

/** One branch rule: the branches it matches and what it changes for them. Its own checks unfold as they're chosen. */
function BranchRuleFields({ draft, index, busy, problems, options, edit, remove }: BranchRuleFieldsProps) {
	const these = draft.checks === "these";
	const pattern = problemsFor(problems, `rule-pattern-${index}`);
	const required = problemsFor(problems, `rule-required-${index}`);
	const vetoes = problemsFor(problems, `rule-vetoes-${index}`);
	const grants = problemsFor(problems, `rule-grants-${index}`);
	const verify = problemsFor(problems, `rule-verify-${index}`);
	const whole = problemsFor(problems, `rule-${index}`);
	return (
		<fieldset className={cn(RULE, "gap-0")} disabled={busy} aria-describedby={whole.attrs["aria-describedby"]}>
			<legend className="px-1 text-ui font-semibold">Rule {index + 1}</legend>
			<SettingField>
				<Label htmlFor={`rule-pattern-${index}`}>Branches</Label>
				<Input
					id={`rule-pattern-${index}`}
					className={COMMAND}
					placeholder="feature/*"
					value={draft.pattern}
					onChange={(event) => edit({ pattern: event.target.value })}
					spellCheck={false}
					{...pattern.attrs}
				/>
				{pattern.line}
			</SettingField>
			<div className={cn(GRID, "mt-3")}>
				<SettingField>
					<Label htmlFor={`rule-required-${index}`}>Required approvals</Label>
					<Input
						id={`rule-required-${index}`}
						inputMode="numeric"
						placeholder="The repo's"
						value={draft.required}
						onChange={(event) => edit({ required: event.target.value })}
						{...required.attrs}
					/>
					{required.line}
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-checks-${index}`}>Checks</Label>
					<NativeSelect
						id={`rule-checks-${index}`}
						value={draft.checks}
						onChange={(event) => edit({ checks: event.target.value as RuleDraft["checks"] })}
					>
						<option value="repo">The repo's</option>
						<option value="none">None</option>
						<option value="these">These</option>
					</NativeSelect>
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-vetoes-${index}`}>Roles that can block</Label>
					<TokenInput
						id={`rule-vetoes-${index}`}
						value={tokensOf(draft.vetoes)}
						onChange={(chosen) => edit({ vetoes: textOf(chosen) })}
						options={options.roles}
						problemOf={roleProblem}
						placeholder="The repo's"
						disabled={busy}
						aria-invalid={!!vetoes.attrs["aria-invalid"]}
						aria-describedby={vetoes.attrs["aria-describedby"]}
					/>
					{vetoes.line}
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-grants-${index}`}>Who may vote as them</Label>
					<TokenInput
						id={`rule-grants-${index}`}
						value={tokensOf(draft.grants)}
						onChange={(chosen) => edit({ grants: textOf(chosen) })}
						options={options.holders}
						labelOf={holderLabel}
						resolve={resolveHolder}
						placeholder="People and GitHive's reviewers"
						disabled={busy}
						aria-invalid={!!grants.attrs["aria-invalid"]}
						aria-describedby={grants.attrs["aria-describedby"]}
					/>
					{grants.line}
				</SettingField>
			</div>
			<Fold open={these} className="-mx-1 -mb-1">
				<SettingField className="px-1 pt-3 pb-1">
					<Label htmlFor={`rule-verify-${index}`}>Its checks, one command a line</Label>
					<Textarea
						id={`rule-verify-${index}`}
						className={cn(COMMAND, "leading-[1.45]")}
						value={draft.verify}
						onChange={(event) => edit({ verify: event.target.value })}
						spellCheck={false}
						{...verify.attrs}
					/>
					{verify.line}
				</SettingField>
			</Fold>
			{whole.line ? <div className="mt-3">{whole.line}</div> : null}
			<Button variant="link" className={cn(REMOVE, "mt-3")} onClick={remove}>
				Remove rule {index + 1}
			</Button>
		</fieldset>
	);
}
