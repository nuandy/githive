import type { BranchRule, SettingsInput } from "../api";
import { ROLE, splitList } from "./mergeSettings";

// The Settings tab's branch rules: other branches' settings by pattern, as
// text fields while they're edited, and back to what the settings tool takes.
// A field left blank is the repo's own.

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
			checks: rule.verify === undefined ? "repo" : rule.verify.length ? "these" : "none",
			verify: (rule.verify ?? []).join("\n"),
		};
	});
}

/** A pattern's characters: a branch name's, and * for any run of them. */
const PATTERN = /^[A-Za-z0-9._/*-]+$/;

/** What the settings tool takes, from the drafts; or what's wrong with them. */
export function branchRulesFrom(
	drafts: RuleDraft[],
): { rules: NonNullable<SettingsInput["branch_rules"]>; errors: [] } | { rules?: undefined; errors: string[] } {
	const errors: string[] = [];
	const rules = drafts.map((draft, i) => {
		const name = draft.pattern.trim() || `Rule ${i + 1}`;
		if (!PATTERN.test(draft.pattern.trim()))
			errors.push(`${name}: the pattern is a branch name, with * for any run of characters (feature/*).`);
		const required = draft.required.trim();
		if (required && !/^\d+$/.test(required))
			errors.push(`${name}: approvals is a whole number, or blank for the repo's.`);
		const vetoes = splitList(draft.vetoes);
		for (const role of vetoes)
			if (!ROLE.test(role)) errors.push(`${name}: "${role}" isn't a role name: lowercase words joined by hyphens.`);
		const holders = splitList(draft.grants);
		if (holders.length && !vetoes.length)
			errors.push(`${name}: say which roles can block before who may vote as them.`);
		const verify =
			draft.checks === "repo" ? undefined : draft.checks === "none" ? [] : splitList(draft.verify.replace(/\n/g, ","));
		if (draft.checks === "these" && !verify?.length) errors.push(`${name}: list its checks, or choose none.`);
		const changes = !!required || vetoes.length > 0 || verify !== undefined;
		if (!changes) errors.push(`${name} changes nothing: set approvals, roles or checks, or remove it.`);
		return {
			pattern: draft.pattern.trim(),
			...(required ? { required: Number(required) } : {}),
			...(vetoes.length ? { vetoes } : {}),
			...(holders.length ? { grants: Object.fromEntries(vetoes.map((role) => [role, holders])) } : {}),
			...(verify !== undefined ? { verify } : {}),
		};
	});
	return errors.length ? { errors: [...new Set(errors)] } : { rules, errors: [] };
}
