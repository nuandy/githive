import { type FormEvent, type ReactNode, useState } from "react";
import type { RepoSnapshot, SavedMergeSettings, SettingsInput } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useHeldDraft } from "../hooks/useHeldDraft";
import { messageOf } from "../lib/errors";
import {
	blockingRolesOf,
	draftFrom,
	type MergeDraft,
	type MergePart,
	mergeDirty,
	partDirty,
	partInput,
	previewPolicy,
	type Problem,
	problemsOf,
	rebase,
	withFresh,
} from "../lib/mergeSettings";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { type DraftStore, draftKey } from "../lib/settingsDrafts";
import { holderLabel, resolveHolder, roleProblem, type TokenOption, textOf, tokensOf } from "../lib/tokens";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { MergeChecks } from "./MergeChecks";
import { MergePolicyTerms } from "./PolicyTerms";
import {
	problemsFor,
	REMOVE,
	RULE,
	type Said,
	saveBarSays,
	savedStatus,
	SETTINGS_FIELDS,
	SettingField,
	SettingHint,
	SettingsPart,
} from "./SettingsParts";
import { Button } from "./ui/button";
import { Collapse, Fold } from "./ui/collapse";
import { Input, Label, Textarea } from "./ui/field";
import { TERMS } from "./ui/manage";
import { SaveBar } from "./ui/save-bar";
import { TokenInput } from "./ui/token-input";

// How changes merge, for the repo's admins: Review (approvals, who can block, who may vote as each), Path rules and
// Checks, each a section of Settings with its own save bar. They edit one draft, held for the session (settingsDrafts),
// and each saves only its own fields.

/** What every section of an admin's Settings gets. */
export interface SettingsContext {
	repo: string;
	branch: string;
	snapshot: Pick<RepoSnapshot, "policy" | "verify" | "skipChecks" | "branchRules" | "github">;
	/** The settings tool, for this repo. */
	save(settings: SettingsInput): Promise<SavedMergeSettings>;
	/** After a save: refresh what the page shows. */
	onSaved?(): void;
	drafts: DraftStore;
	/** What the token inputs offer: roles, and who may vote as them. */
	options: { roles: TokenOption[]; holders: TokenOption[] };
}

/** What each part of a merge section gets: the draft, a way to change it, whether a save is under way, and problems. */
export interface DraftSectionProps {
	draft: MergeDraft;
	update(patch: Partial<MergeDraft>): void;
	busy: boolean;
	/** What's wrong, by field, once a save was tried. */
	problems?: Problem[];
}

type PathRuleDraft = MergeDraft["escalate"][number];

/** A line a save of these settings applies from: said by each section's description. */
const FROM_NOW_ON =
	"A save applies to merges from then on: each merge is audited against the settings in force when it merged.";

/** What a section's save said: the settings now in force, in a few words, and any warnings with them. */
function savedWords(part: MergePart, saved: SavedMergeSettings): ReactNode {
	const { policy, verify } = saved;
	const blockers = blockingRolesOf(draftFrom(policy, verify));
	let words: string;
	if (part === "review")
		words =
			`Saved. Merges from now on need ${counted(policy.required, "approval")}` +
			(blockers.length ? `, and ${blockers.join(", ")} can block.` : ".");
	else if (part === "path-rules")
		words = policy.escalate?.length
			? `Saved. ${counted(policy.escalate.length, "path rule")} from now on.`
			: "Saved. No path is stricter than the rest.";
	else
		words = verify.length
			? `Saved. Changes pass ${counted(verify.length, "check")} before they land.`
			: "Saved. Changes land without checks.";
	return (
		<>
			{savedStatus(words)}
			{(saved.warnings ?? []).map((warning) => (
				<span key={warning} className="mt-1 flex items-start gap-1.5 text-muted-foreground">
					<Icon name="alert" size={14} className="mt-0.75 shrink-0" />
					<span>{warning}</span>
				</span>
			))}
		</>
	);
}

/**
 * One section's share of the merge settings: the draft (held, so it outlives the section), changing it, and saving or
 * discarding this section's fields alone. Problems show once a save was tried, and as they're put right. (Exported
 * for its tests.)
 */
export function useMergeSection(part: MergePart, { repo, snapshot, save, onSaved, drafts }: SettingsContext) {
	const fresh = draftFrom(snapshot.policy, snapshot.verify, snapshot.skipChecks);
	// A section without edits follows the server's settings while another has some.
	const held = useHeldDraft(drafts, draftKey(repo, "merge"), fresh, mergeDirty, withFresh);
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const { draft, base } = held;
	const problems = tried ? problemsOf(draft).filter((problem) => problem.part === part) : [];

	const update = (patch: Partial<MergeDraft>) => {
		setSaid(null);
		held.edit((current) => ({ ...current, ...patch }));
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setTried(true);
		const result = partInput(part, draft, base);
		if (!result.input) return;
		setBusy(true);
		setSaid(null);
		try {
			const done = await save(result.input);
			const saved = draftFrom(done.policy, done.verify, done.skipChecks);
			// From the draft as it is now: edits made while it saved stay.
			held.saved(saved, (current) => rebase(current.draft, current.base, saved, part));
			setTried(false);
			setSaid({ saved: savedWords(part, done) });
			onSaved?.();
		} catch (err) {
			setSaid({ failed: messageOf(err) });
		} finally {
			setBusy(false);
		}
	};
	const discard = () => {
		held.edit((current) => rebase(current, base, base, part));
		setTried(false);
		setSaid(null);
	};
	return {
		draft,
		update,
		busy,
		problems,
		dirty: partDirty(part, draft, base),
		says: saveBarSays(said, problems),
		submit,
		discard,
	};
}

/** The policy the draft makes, in words, as it's edited: what readers of Settings see once it's saved. */
function WhatThisMeans({ draft }: { draft: MergeDraft }) {
	const verify = draft.verify.map((command) => command.trim()).filter(Boolean);
	return (
		<section aria-labelledby="what-this-means" className="rounded-md bg-surface-2 px-4 py-3.5">
			<h3 id="what-this-means" className="mb-2.5 text-body-sm font-semibold">
				What this means
			</h3>
			<dl className={cn(TERMS, "text-ui")}>
				<MergePolicyTerms policy={previewPolicy(draft)} verify={verify} />
			</dl>
		</section>
	);
}

/** The review policy: how many approvals, the roles that can block any change, and who may vote as each. */
export function ReviewSection(context: SettingsContext) {
	const form = useMergeSection("review", context);
	const { draft, update, busy, problems } = form;
	const required = problemsFor(problems, "settings-required", "settings-required-hint");
	const vetoes = problemsFor(problems, "settings-vetoes", "settings-vetoes-hint");
	return (
		<form className="grid gap-4" onSubmit={form.submit} noValidate>
			<SettingsPart
				id="settings-review"
				title="Review"
				description={`How many approvals a change needs to merge, and which roles can block it. ${FROM_NOW_ON}`}
			>
				<fieldset className={cn(SETTINGS_FIELDS, "m-0 min-w-0 border-0 px-0.5 py-4")} disabled={busy}>
					<SettingField>
						<Label htmlFor="settings-required">Required approvals</Label>
						<Input
							id="settings-required"
							type="number"
							className="max-w-35"
							min={0}
							inputMode="numeric"
							value={draft.required}
							onChange={(event) => update({ required: event.target.value })}
							{...required.attrs}
						/>
						{required.line}
						<SettingHint id="settings-required-hint">
							A person and their agents approve once between them. 0 merges a change on its checks alone (a role that
							can block must still approve).
						</SettingHint>
					</SettingField>
					<SettingField>
						<Label className="flex items-start gap-2 font-normal">
							{/* Centred on the first line, however many lines the text takes. */}
							<input
								type="checkbox"
								className="m-0 mt-[calc(0.5lh-6.5px)] shrink-0"
								checked={draft.independent}
								onChange={(event) => update({ independent: event.target.checked })}
							/>
							Independent review: approvals come from someone other than the change's author
						</Label>
						<SettingHint>
							Off, a person's agents may approve each other's changes, and a lone agent its own, reviewed in a fresh
							context. For an independent review either way, GitHive's reviewers can review it.
						</SettingHint>
					</SettingField>
					<SettingField>
						<Label htmlFor="settings-vetoes">Roles that can block any change</Label>
						<TokenInput
							id="settings-vetoes"
							value={tokensOf(draft.vetoes)}
							onChange={(roles) => update({ vetoes: textOf(roles) })}
							options={context.options.roles}
							problemOf={roleProblem}
							placeholder="security"
							disabled={busy}
							aria-invalid={!!vetoes.attrs["aria-invalid"]}
							aria-describedby={vetoes.attrs["aria-describedby"]}
						/>
						{vetoes.line}
						<SettingHint id="settings-vetoes-hint">
							Each must approve, and one rejection blocks the merge. A role is lowercase words joined by hyphens, like
							security or api-design.
						</SettingHint>
					</SettingField>
					<RoleGrants draft={draft} update={update} busy={busy} holders={context.options.holders} />
				</fieldset>
			</SettingsPart>
			<WhatThisMeans draft={draft} />
			<SaveBar {...form.says} dirty={form.dirty} busy={busy} onDiscard={form.discard} />
		</form>
	);
}

/** Who may vote as each role that can block: it unfolds once there is such a role, and folds away with the last. */
function RoleGrants({ draft, update, busy, holders }: DraftSectionProps & { holders: TokenOption[] }) {
	const blocking = blockingRolesOf(draft);
	// While it folds away, it still shows the roles it last had.
	const [shown, setShown] = useState(blocking);
	if (blocking.length && blocking.join() !== shown.join()) setShown(blocking);
	return (
		<Fold open={blocking.length > 0} className="-mx-1 -mb-1">
			<fieldset className="m-0 grid min-w-0 gap-3 border-0 px-1 pt-0 pb-1" aria-describedby="grants-hint">
				<legend className="mb-1 p-0 font-semibold">Who may vote as each role that can block</legend>
				<SettingHint id="grants-hint" className="-mt-2">
					Choose the org's teams or your agents, Any person or GitHive's reviewers, or type an agent's name. Left blank,
					a role is open to people and GitHive's reviewers.
				</SettingHint>
				{shown.map((role) => (
					<SettingField key={role}>
						<Label htmlFor={`grant-${role}`}>
							<code>{role}</code>
						</Label>
						<TokenInput
							id={`grant-${role}`}
							value={tokensOf(draft.grants[role] ?? "")}
							onChange={(chosen) => update({ grants: { ...draft.grants, [role]: textOf(chosen) } })}
							options={holders}
							labelOf={holderLabel}
							resolve={resolveHolder}
							placeholder="Any person, GitHive's reviewers"
							disabled={busy}
						/>
					</SettingField>
				))}
			</fieldset>
		</Fold>
	);
}

/** Stricter rules for chosen paths: more approvals, more roles that can block. */
export function PathRulesSection(context: SettingsContext) {
	const form = useMergeSection("path-rules", context);
	const { draft, update, busy, problems } = form;
	const changeRule = (index: number, patch: Partial<PathRuleDraft>) => {
		const escalate = draft.escalate.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule));
		update({ escalate });
	};
	const removeRule = (index: number) =>
		update({ escalate: draft.escalate.filter((_, ruleIndex) => ruleIndex !== index) });
	const addRule = () => update({ escalate: [...draft.escalate, { paths: "", required: "", vetoes: "" }] });
	// A rule added after the page showed unfolds into place.
	const added = useArrivals(draft.escalate.map((_, index) => String(index)));

	return (
		<form className="grid gap-4" onSubmit={form.submit} noValidate>
			<SettingsPart
				id="settings-path-rules"
				title="Path rules"
				description={`A change touching any of a rule's paths needs at least its approvals, and its roles can block it. ${FROM_NOW_ON}`}
			>
				<div className={cn(SETTINGS_FIELDS, "px-0.5 py-4")}>
					{draft.escalate.length ? null : (
						<p className="m-0 text-muted-foreground">No path rules: every change needs what Review sets.</p>
					)}
					{draft.escalate.map((rule, index) => (
						<Collapse key={index} open appear={added(String(index))} className="-m-1">
							<div className="p-1">
								<PathRule
									rule={rule}
									index={index}
									busy={busy}
									problems={problems}
									roles={context.options.roles}
									change={(patch) => changeRule(index, patch)}
									remove={() => removeRule(index)}
								/>
							</div>
						</Collapse>
					))}
					<div>
						<Button onClick={addRule} disabled={busy}>
							<Icon name="plus" />
							Add a rule
						</Button>
					</div>
					<SettingHint>
						Who may vote as a role a rule adds is set under <a href={href.settings(context.repo, "review")}>Review</a>.
					</SettingHint>
				</div>
			</SettingsPart>
			<WhatThisMeans draft={draft} />
			<SaveBar {...form.says} dirty={form.dirty} busy={busy} onDiscard={form.discard} />
		</form>
	);
}

interface PathRuleProps {
	rule: PathRuleDraft;
	index: number;
	busy: boolean;
	problems: Problem[];
	roles: TokenOption[];
	change(patch: Partial<PathRuleDraft>): void;
	remove(): void;
}

function PathRule({ rule, index, busy, problems, roles, change, remove }: PathRuleProps) {
	const paths = problemsFor(problems, `rule-${index}-paths`);
	const required = problemsFor(problems, `rule-${index}-required`, `rule-${index}-required-hint`);
	const vetoes = problemsFor(problems, `rule-${index}-vetoes`);
	return (
		<fieldset className={RULE} disabled={busy}>
			<legend className="px-1 text-ui font-semibold">Rule {index + 1}</legend>
			<SettingField>
				<Label htmlFor={`rule-${index}-paths`}>Paths, one a line</Label>
				<Textarea
					id={`rule-${index}-paths`}
					rows={3}
					className="font-mono text-meta"
					value={rule.paths}
					onChange={(event) => change({ paths: event.target.value })}
					spellCheck={false}
					{...paths.attrs}
				/>
				{paths.line}
			</SettingField>
			<div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 to-560:grid-cols-1">
				<SettingField>
					<Label htmlFor={`rule-${index}-required`}>Approvals</Label>
					<Input
						id={`rule-${index}-required`}
						type="number"
						min={0}
						inputMode="numeric"
						value={rule.required}
						onChange={(event) => change({ required: event.target.value })}
						{...required.attrs}
					/>
					{required.line}
					<SettingHint id={`rule-${index}-required-hint`}>Blank: as Review sets</SettingHint>
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-${index}-vetoes`}>Roles that can block</Label>
					<TokenInput
						id={`rule-${index}-vetoes`}
						value={tokensOf(rule.vetoes)}
						onChange={(chosen) => change({ vetoes: textOf(chosen) })}
						options={roles}
						problemOf={roleProblem}
						disabled={busy}
						aria-invalid={!!vetoes.attrs["aria-invalid"]}
						aria-describedby={vetoes.attrs["aria-describedby"]}
					/>
					{vetoes.line}
				</SettingField>
			</div>
			<Button variant="link" className={REMOVE} onClick={remove}>
				Remove rule {index + 1}
			</Button>
		</fieldset>
	);
}

/** The checks a change must pass before it lands, what they skip, and what they run in. */
export function ChecksSection(context: SettingsContext) {
	const form = useMergeSection("checks", context);
	return (
		<form className="grid gap-4" onSubmit={form.submit} noValidate>
			<SettingsPart
				id="settings-checks"
				title="Checks"
				description={
					`Commands that must pass on a change merged into ${context.branch} before it lands, run by GitHive in its ` +
					"own container. None: a change merges once approved, and no container runs. A save applies from then on."
				}
			>
				<MergeChecks
					draft={form.draft}
					update={form.update}
					busy={form.busy}
					problems={form.problems}
					branch={context.branch}
				/>
			</SettingsPart>
			<SaveBar {...form.says} dirty={form.dirty} busy={form.busy} onDiscard={form.discard} />
		</form>
	);
}
