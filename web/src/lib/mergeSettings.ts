import type { RepoSnapshot, SettingsInput } from "../api";
import { DEFAULT_SKIP_CHECKS } from "../../../src/toolkit/check-scope";
import { ROLE, roleProblem, tokensOf } from "./tokens";

// The Settings tab's form for how changes merge: the review policy, the path rules and the checks, each a section of
// its own, as text fields while they're edited, and back to what the settings tool takes. Each section saves only its
// own fields; the server keeps what's left out.

export { ROLE };

type Policy = RepoSnapshot["policy"];

/** The form's fields: lists as comma- or line-separated text. */
export interface MergeDraft {
	required: string;
	/** Roles that can block any change. */
	vetoes: string;
	/** Who may vote as each role that can block: blank for the default (people and GitHive's reviewers). */
	grants: Record<string, string>;
	/** Stricter rules for chosen paths: approvals blank for the repo's own. */
	escalate: { paths: string; required: string; vetoes: string }[];
	verify: string[];
	/** What the checks skip, one pattern a line (blank: nothing, the checks always run). */
	skipChecks: string;
}

/** The sections of Settings the draft is edited in. */
export type MergePart = "review" | "path-rules" | "checks";
const PARTS: MergePart[] = ["review", "path-rules", "checks"];

/** Each section's fields of the draft. */
const FIELDS: Record<MergePart, (keyof MergeDraft)[]> = {
	review: ["required", "vetoes", "grants"],
	"path-rules": ["escalate"],
	checks: ["verify", "skipChecks"],
};

/** What's wrong with the draft: in which section, under which field (by its id), and what to do about it. */
export interface Problem {
	part: MergePart;
	field: string;
	text: string;
}

export const splitList = tokensOf;

/**
 * The form's fields from the settings. When the server doesn't say what the checks skip, its defaults fill in,
 * so a save never turns skipping off unasked.
 */
export function draftFrom(policy: Policy, verify: string[], skipChecks: string[] = DEFAULT_SKIP_CHECKS): MergeDraft {
	return {
		skipChecks: skipChecks.join("\n"),
		required: String(policy.required),
		vetoes: policy.vetoes.join(", "),
		grants: Object.fromEntries(
			Object.entries(policy.grants ?? {}).map(([role, holders]) => [role, holders.join(", ")]),
		),
		escalate: (policy.escalate ?? []).map((rule) => ({
			paths: rule.paths.join("\n"),
			required: rule.required === undefined ? "" : String(rule.required),
			vetoes: (rule.vetoes ?? []).join(", "),
		})),
		verify: [...verify],
	};
}

/** Every role that can block a change in the draft: the repo's own, then those the path rules add. */
export function blockingRolesOf(draft: Pick<MergeDraft, "vetoes" | "escalate">): string[] {
	const ruleVetoes = draft.escalate.flatMap((rule) => splitList(rule.vetoes));
	const roles = new Set([...splitList(draft.vetoes), ...ruleVetoes]);
	return [...roles].filter((role) => ROLE.test(role));
}

const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const SKIP = /^[A-Za-z0-9._/*@+-]+$/;

/** What's wrong with the draft, field by field, in the order the fields come. */
export function problemsOf(draft: MergeDraft): Problem[] {
	const problems: Problem[] = [];
	const say = (part: MergePart, field: string, text: string) => problems.push({ part, field, text });
	const roles = (part: MergePart, field: string, text: string) =>
		splitList(text).forEach((role) => {
			const problem = roleProblem(role);
			if (problem) say(part, field, problem);
		});
	if (whole(draft.required) === null)
		say("review", "settings-required", "Required approvals is a whole number, 0 for none.");
	roles("review", "settings-vetoes", draft.vetoes);
	draft.escalate.forEach((rule, index) => {
		if (!splitList(rule.paths).length) say("path-rules", `rule-${index}-paths`, `Rule ${index + 1} names no paths.`);
		if (rule.required.trim() && whole(rule.required) === null)
			say(
				"path-rules",
				`rule-${index}-required`,
				`Rule ${index + 1}'s approvals is a whole number, or blank for the repo's own.`,
			);
		roles("path-rules", `rule-${index}-vetoes`, rule.vetoes);
	});
	for (const pattern of splitList(draft.skipChecks))
		if (!SKIP.test(pattern))
			say(
				"checks",
				"skip-checks",
				`"${pattern}" isn't a pattern: a path or name, with * for any run of characters (*.md, docs/).`,
			);
	return problems;
}

/** Who may vote as each role in `roles` that the draft names anyone for; a blank one is the default. */
function grantsFor(draft: MergeDraft, roles: string[]): Record<string, string[]> {
	const grants: Record<string, string[]> = {};
	for (const role of roles) {
		const holders = splitList(draft.grants[role] ?? "");
		if (holders.length) grants[role] = holders;
	}
	return grants;
}

/** The path rules as the settings tool takes them. */
function escalateOf(draft: MergeDraft): NonNullable<SettingsInput["escalate"]> {
	return draft.escalate.map((row) => {
		const required = row.required.trim() ? whole(row.required) : null;
		const vetoes = splitList(row.vetoes);
		return {
			paths: splitList(row.paths),
			...(required !== null ? { required } : {}),
			...(vetoes.length ? { vetoes } : {}),
		};
	});
}

const checksOf = (draft: MergeDraft) => ({
	verify: draft.verify.map((command) => command.trim()).filter(Boolean),
	skip_checks: splitList(draft.skipChecks),
});

/** What the settings tool takes, from the whole draft; or what's wrong with it. */
export function settingsFrom(
	draft: MergeDraft,
): { settings: SettingsInput; errors: [] } | { settings?: undefined; errors: string[] } {
	const problems = problemsOf(draft);
	if (problems.length) return { errors: [...new Set(problems.map((problem) => problem.text))] };
	return {
		settings: {
			required: whole(draft.required)!,
			vetoes: splitList(draft.vetoes),
			escalate: escalateOf(draft),
			// Grants only for roles that can still block.
			grants: grantsFor(draft, blockingRolesOf(draft)),
			...checksOf(draft),
		},
		errors: [],
	};
}

/**
 * What one section saves, from the draft, or what's wrong with it there. Review sends who may vote for every role
 * that blocks in the draft, or in the path rules as saved (`base`), so saving it never drops a grant the saved rules
 * still use; a role it no longer has block, that no rule uses, loses its grant.
 */
export function partInput(
	part: MergePart,
	draft: MergeDraft,
	base: MergeDraft,
): { input: SettingsInput; problems: [] } | { input?: undefined; problems: Problem[] } {
	const problems = problemsOf(draft).filter((problem) => problem.part === part);
	if (problems.length) return { problems };
	if (part === "path-rules") return { input: { escalate: escalateOf(draft) }, problems: [] };
	if (part === "checks") return { input: checksOf(draft), problems: [] };
	const roles = [...new Set([...blockingRolesOf(draft), ...blockingRolesOf({ vetoes: "", escalate: base.escalate })])];
	return {
		input: { required: whole(draft.required)!, vetoes: splitList(draft.vetoes), grants: grantsFor(draft, roles) },
		problems: [],
	};
}

const partKey = (part: MergePart, draft: MergeDraft) => JSON.stringify(FIELDS[part].map((field) => draft[field]));

/** Whether a section has edits: its fields differ from what's saved. */
export const partDirty = (part: MergePart, draft: MergeDraft, base: MergeDraft) =>
	partKey(part, draft) !== partKey(part, base);

/**
 * The draft once `saved` (the server's settings after a save of `part`, or as they are now) is the base: the section
 * saved, and every section that had no edits, take the server's settings; one with edits keeps them.
 */
export function rebase(draft: MergeDraft, base: MergeDraft, saved: MergeDraft, part?: MergePart): MergeDraft {
	const next = { ...draft };
	for (const each of PARTS)
		if (each === part || !partDirty(each, draft, base))
			for (const field of FIELDS[each]) Object.assign(next, { [field]: saved[field] });
	return next;
}

/**
 * A held draft with the server's settings as they are now (`fresh`): each section without edits shows them, and is
 * made from them; one with edits keeps its edits and what they were made from. (Whether a section has edits reads the
 * same either way round, so the base rebases as the draft does.)
 */
export function withFresh<T extends { draft: MergeDraft; base: MergeDraft }>(held: T, fresh: MergeDraft): T {
	return { ...held, draft: rebase(held.draft, held.base, fresh), base: rebase(held.base, held.draft, fresh) };
}

/** The draft as a policy, as far as it reads (a role that isn't one is left out), to say what it means. */
export function previewPolicy(draft: MergeDraft): Policy {
	const valid = (text: string) => splitList(text).filter((role) => ROLE.test(role));
	const escalate = draft.escalate
		.map((rule) => {
			const required = whole(rule.required);
			const vetoes = valid(rule.vetoes);
			return {
				paths: splitList(rule.paths),
				...(required !== null ? { required } : {}),
				...(vetoes.length ? { vetoes } : {}),
			};
		})
		.filter((rule) => rule.paths.length);
	const grants = grantsFor(draft, blockingRolesOf(draft));
	return {
		required: whole(draft.required) ?? 0,
		vetoes: valid(draft.vetoes),
		...(escalate.length ? { escalate } : {}),
		...(Object.keys(grants).length ? { grants } : {}),
	};
}

/** Whether any section of the draft has edits. */
export const mergeDirty = (draft: MergeDraft, base: MergeDraft) => PARTS.some((part) => partDirty(part, draft, base));
