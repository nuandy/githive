import type { BranchRule, SettingsInput } from "../api";
import { ROLE, splitList } from "./mergeSettings";

// The Settings tab's branch rules: other branches' settings by pattern, as
// text fields while they're edited, and back to what the settings tool takes.
// A field left blank is the repo's own.

type BranchRuleInput = NonNullable<SettingsInput["branch_rules"]>[number];

export interface RuleDraft {
	pattern: string;
	/** Blank: the repo's. */
	required: string;
	/** Roles that can block, blank for the repo's. */
	vetoes: string;
	/** Who may vote as those roles, blank for the default. */
	grants: string;
	checks: "repo" | "none" | "these";
	verify: string;
}

export const emptyRule = (): RuleDraft => ({
	pattern: "",
	required: "",
	vetoes: "",
	grants: "",
	checks: "repo",
	verify: "",
});

export function ruleDraftsFrom(rules: BranchRule[] | undefined): RuleDraft[] {
	return (rules ?? []).map((rule) => {
		const vetoes = rule.policy?.vetoes ?? [];
		const holders = [...new Set(vetoes.flatMap((role) => rule.policy?.grants?.[role] ?? []))];
		return {
			pattern: rule.pattern,
			required: rule.policy?.required === undefined ? "" : String(rule.policy.required),
			vetoes: vetoes.join(", "),
			grants: holders.join(", "),
			checks: checksOf(rule.verify),
			verify: (rule.verify ?? []).join("\n"),
		};
	});
}

function checksOf(verify: string[] | undefined): RuleDraft["checks"] {
	if (verify === undefined) return "repo";
	return verify.length ? "these" : "none";
}

/** The checks a draft sets: the repo's (undefined), none, or the ones listed. */
function verifyOf(draft: RuleDraft): string[] | undefined {
	if (draft.checks === "repo") return undefined;
	if (draft.checks === "none") return [];
	return splitList(draft.verify.replace(/\n/g, ","));
}

/** A pattern's characters: a branch name's, and * for any run of them. */
const PATTERN = /^[A-Za-z0-9._/*-]+$/;

/** What's wrong with a draft, under which field (by its id), or under the rule (`rule-<index>`) for the whole rule. */
export interface RuleProblem {
	field: string;
	text: string;
}

/** What's wrong with the drafts, rule by rule, field by field. */
export function branchRuleProblems(drafts: RuleDraft[]): RuleProblem[] {
	const problems: RuleProblem[] = [];
	drafts.forEach((draft, index) => {
		const say = (field: string, text: string) => problems.push({ field, text });
		const name = draft.pattern.trim() || `Rule ${index + 1}`;
		if (!PATTERN.test(draft.pattern.trim()))
			say(
				`rule-pattern-${index}`,
				`${name}: the pattern is a branch name, with * for any run of characters (feature/*).`,
			);
		const required = draft.required.trim();
		if (required && !/^\d+$/.test(required))
			say(`rule-required-${index}`, `${name}: approvals is a whole number, or blank for the repo's.`);
		const vetoes = splitList(draft.vetoes);
		for (const role of vetoes)
			if (!ROLE.test(role))
				say(`rule-vetoes-${index}`, `${name}: "${role}" isn't a role name: lowercase words joined by hyphens.`);
		if (splitList(draft.grants).length && !vetoes.length)
			say(`rule-grants-${index}`, `${name}: say which roles can block before who may vote as them.`);
		const verify = verifyOf(draft);
		if (draft.checks === "these" && !verify?.length)
			say(`rule-verify-${index}`, `${name}: list its checks, or choose none.`);
		if (!required && !vetoes.length && verify === undefined)
			say(`rule-${index}`, `${name} changes nothing: set approvals, roles or checks, or remove it.`);
	});
	return problems;
}

/** What the settings tool takes, from the drafts; or what's wrong with them. */
export function branchRulesFrom(
	drafts: RuleDraft[],
): { rules: NonNullable<SettingsInput["branch_rules"]>; errors: [] } | { rules?: undefined; errors: string[] } {
	const problems = branchRuleProblems(drafts);
	if (problems.length) return { errors: [...new Set(problems.map((problem) => problem.text))] };
	const rules = drafts.map((draft) => {
		const required = draft.required.trim();
		const vetoes = splitList(draft.vetoes);
		const holders = splitList(draft.grants);
		const verify = verifyOf(draft);
		const rule: BranchRuleInput = { pattern: draft.pattern.trim() };
		if (required) rule.required = Number(required);
		if (vetoes.length) rule.vetoes = vetoes;
		if (holders.length) rule.grants = Object.fromEntries(vetoes.map((role) => [role, holders]));
		if (verify !== undefined) rule.verify = verify;
		return rule;
	});
	return { rules, errors: [] };
}
