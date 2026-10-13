import { type ComponentProps, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { counted } from "../lib/plural";
import type { RepoSnapshot, SavedMergeSettings, SettingsInput } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { blockingRolesOf, draftFrom, type MergeDraft, settingsFrom } from "../lib/mergeSettings";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { MergeChecks } from "./MergeChecks";
import { Box, BoxBody, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { Collapse, Fold } from "./ui/collapse";
import { Field, FieldHint, Input, Label, Textarea } from "./ui/field";

// The Settings tab's forms (this one, MergeChecks, BranchRules, GitHubSettings) share their parts: a ruled section
// per topic, its fields a little apart, and a bar at the foot with the form's buttons, staying in view as it scrolls.

/** A settings form: its sections, then its save bar. */
export const SETTINGS_FORM = "grid gap-4";
/** A section's fields. */
export const SETTINGS_FIELDS = "grid gap-3.5";
/**
 * A command, a path or a repo's name, typed in a field, at the field's own line height (a font size drops the one
 * before it); a long text field adds its own after this.
 */
export const COMMAND = "font-mono text-meta leading-[inherit]";
/** A group of fields in a ruled frame, its legend on the frame (a path rule, a branch rule). */
export const RULE = "m-0 grid min-w-0 gap-2 rounded-md border border-border p-3";
/** A link-like button that takes a rule away. */
export const REMOVE = "justify-self-start text-bad";

/** A section of a settings form, under its title. */
export function SettingsSection({
	id,
	title,
	children,
	...props
}: ComponentProps<"section"> & { id: string; title: ReactNode }) {
	return (
		<Box aria-labelledby={id} {...props}>
			<BoxHeader>
				<h2 id={id} className="text-body-sm font-semibold">
					{title}
				</h2>
			</BoxHeader>
			{children}
		</Box>
	);
}

/** A field in a settings form: its label, control and hint, close together. */
export function SettingField({ className, ...props }: ComponentProps<"div">) {
	return <Field className={cn("gap-1", className)} {...props} />;
}

export function SettingHint({ className, ...props }: ComponentProps<"p">) {
	return <FieldHint className={cn("text-meta", className)} {...props} />;
}

/** The foot of a settings form: what the save said, and its buttons, kept in view at the window's foot. */
export function SaveBar({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"sticky bottom-0 grid gap-2 bg-[linear-gradient(to_bottom,transparent,var(--background)_30%)] py-3",
				className,
			)}
			{...props}
		/>
	);
}

/** What's wrong with the form, as the save found it. */
export function SaveErrors({ errors }: { errors: string[] }) {
	if (!errors.length) return null;
	return (
		<ul
			className="m-0 animate-appear rounded-md bg-bad-soft py-2.5 pr-3.5 pl-7.5 text-ui wrap-anywhere text-bad"
			role="alert"
		>
			{errors.map((error) => (
				<li key={error}>{error}</li>
			))}
		</ul>
	);
}

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
		<form className={SETTINGS_FORM} onSubmit={submit}>
			<ReviewPolicy draft={draft} update={update} busy={busy} />
			<PathRules draft={draft} update={update} busy={busy} />
			<MergeChecks draft={draft} update={update} busy={busy} branch={branch} />
			<SaveBar>
				<SaveErrors errors={errors} />
				{saved ? <SavedNotice saved={saved} /> : null}
				<div className="flex justify-end gap-2">
					<Button disabled={busy || !dirty} onClick={discard}>
						Discard edits
					</Button>
					<Button type="submit" variant="go" disabled={busy || !dirty}>
						{busy ? "Saving…" : "Save settings"}
					</Button>
				</div>
			</SaveBar>
		</form>
	);
}

function ReviewPolicy({ draft, update, busy }: DraftSectionProps) {
	return (
		<SettingsSection id="settings-review" title="Review policy">
			<BoxBody className={SETTINGS_FIELDS}>
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
						disabled={busy}
					/>
					<SettingHint>
						From reviewers other than the change's author. 0 merges a change on its checks alone (a role that can block
						must still approve).
					</SettingHint>
				</SettingField>
				<SettingField>
					<Label htmlFor="settings-vetoes">Roles that can block any change</Label>
					<Input
						id="settings-vetoes"
						value={draft.vetoes}
						onChange={(event) => update({ vetoes: event.target.value })}
						placeholder="security"
						autoComplete="off"
						spellCheck={false}
						disabled={busy}
					/>
					<SettingHint>
						Comma-separated, like security or api-design. Each must approve, and one rejection blocks the merge.
					</SettingHint>
				</SettingField>
				<RoleGrants draft={draft} update={update} busy={busy} />
			</BoxBody>
		</SettingsSection>
	);
}

/** Who may vote as each role that can block: it unfolds once there is such a role, and folds away with the last. */
function RoleGrants({ draft, update, busy }: DraftSectionProps) {
	const blocking = blockingRolesOf(draft);
	// While it folds away, it still shows the roles it last had.
	const [shown, setShown] = useState(blocking);
	if (blocking.length && blocking.join() !== shown.join()) setShown(blocking);
	return (
		<Fold open={blocking.length > 0} className="-mx-1 -mb-1">
			<fieldset className="m-0 min-w-0 border-0 px-1 pt-0 pb-1" disabled={busy}>
				<legend className="mb-1.5 p-0 font-semibold">Who may vote as each role that can block</legend>
				<p className="mt-0 mb-2 text-muted-foreground">
					Agent names, person:* for people, @org/team, or githive for GitHive's reviewers. Blank: people and GitHive's
					reviewers.
				</p>
				{shown.map((role) => (
					<SettingField key={role}>
						<Label htmlFor={`grant-${role}`}>
							<code>{role}</code>
						</Label>
						<Input
							id={`grant-${role}`}
							value={draft.grants[role] ?? ""}
							onChange={(event) => update({ grants: { ...draft.grants, [role]: event.target.value } })}
							placeholder="person:*, githive"
							autoComplete="off"
							spellCheck={false}
						/>
					</SettingField>
				))}
			</fieldset>
		</Fold>
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
	// A rule added after the page showed unfolds into place.
	const added = useArrivals(draft.escalate.map((_, index) => String(index)));

	return (
		<SettingsSection id="settings-escalate" title="Stricter rules for paths">
			<BoxBody className={SETTINGS_FIELDS}>
				<p className="m-0 text-muted-foreground">
					A change touching any of these paths needs at least this many approvals, and these roles can block it.
				</p>
				{draft.escalate.map((rule, index) => (
					<Collapse key={index} open appear={added(String(index))} className="-m-1">
						<div className="p-1">
							<PathRule
								rule={rule}
								index={index}
								busy={busy}
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
			</BoxBody>
		</SettingsSection>
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
		<fieldset className={RULE} disabled={busy}>
			<legend className="px-1 text-ui font-semibold">Rule {index + 1}</legend>
			<SettingField>
				<Label htmlFor={`rule-${index}-paths`}>Paths</Label>
				<Textarea
					id={`rule-${index}-paths`}
					rows={3}
					value={rule.paths}
					onChange={(event) => change({ paths: event.target.value })}
					placeholder={"package.json\n.github/"}
					spellCheck={false}
				/>
			</SettingField>
			<div className="grid grid-cols-[1fr_110px_1fr] gap-2 to-560:grid-cols-1">
				<SettingField>
					<Label htmlFor={`rule-${index}-required`}>Approvals</Label>
					<Input
						id={`rule-${index}-required`}
						type="number"
						className="max-w-35"
						min={0}
						inputMode="numeric"
						value={rule.required}
						onChange={(event) => change({ required: event.target.value })}
						placeholder="same"
					/>
				</SettingField>
				<SettingField>
					<Label htmlFor={`rule-${index}-vetoes`}>Can block</Label>
					<Input
						id={`rule-${index}-vetoes`}
						value={rule.vetoes}
						onChange={(event) => change({ vetoes: event.target.value })}
						placeholder="security"
						autoComplete="off"
						spellCheck={false}
					/>
				</SettingField>
			</div>
			<Button variant="link" className={REMOVE} onClick={remove}>
				Remove rule {index + 1}
			</Button>
		</fieldset>
	);
}

const SAVED = "mt-0 mb-2 flex items-start gap-1.5 text-ui wrap-anywhere text-good";

/** What the last save set, and any warnings the server gave with it. */
function SavedNotice({ saved }: { saved: SavedMergeSettings }) {
	const checks = saved.verify.length ? ` and pass ${counted(saved.verify.length, "check")}` : ", with no checks";
	return (
		<div role="status" className="animate-appear">
			<p className={SAVED}>
				<Icon name="check" /> Saved. Merges from now on need {counted(saved.policy.required, "approval")}
				{checks}.
			</p>
			{(saved.warnings ?? []).map((warning) => (
				<p key={warning} className={cn(SAVED, "text-muted-foreground")}>
					<Icon name="alert" /> {warning}
				</p>
			))}
		</div>
	);
}
