import { BRANCH_PATTERN, type BranchRule } from "../branch-rules";
import { SKIP_PATTERN } from "../check-scope";
import type { ReviewPolicy } from "../votes";
import type { Args, ToolContext } from "./context";

// Parsing the settings tool's input into the registry's policy, checks and branch rules.

/** The settings arguments that make up the review policy. */
export const POLICY_FIELDS = ["required", "vetoes", "escalate", "grants"] as const;

/** Parses branch_rules from settings: a pattern each, with the policy fields and checks it overrides. */
export function branchRulesFrom(value: unknown, base: ReviewPolicy): BranchRule<ReviewPolicy>[] {
	if (!Array.isArray(value))
		throw new Error("[400] branch_rules is a list of rules: each a pattern, and what it changes");
	return value.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error(`[400] branch_rules[${index}] is a rule: a pattern, and what it changes`);
		const rule = raw as Args;
		const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
		if (!pattern || !BRANCH_PATTERN.test(pattern))
			throw new Error(
				`[400] branch_rules[${index}].pattern is a branch name, with * for any run of characters (feature/*)`,
			);
		// Keep only the fields the rule sets, so the rest follow the repo's settings as they change.
		const full = policyFrom(rule, base);
		const policy = Object.fromEntries(
			POLICY_FIELDS.filter((field) => rule[field] !== undefined).map((field) => [field, full[field]]),
		) as Partial<ReviewPolicy>;
		const verify = rule.verify === undefined ? undefined : checksFrom(rule.verify);
		if (!Object.keys(policy).length && !verify)
			throw new Error(
				`[400] branch_rules[${index}] (${pattern}) changes nothing: set required, vetoes, escalate, grants or verify`,
			);
		return { pattern, ...(Object.keys(policy).length ? { policy } : {}), ...(verify ? { verify } : {}) };
	});
}

/** Parses skip_checks: patterns like *.md or docs/ for files the checks skip. */
export function skipPatternsFrom(value: unknown): string[] {
	const isPattern = (item: unknown) => typeof item === "string" && SKIP_PATTERN.test(item.trim());
	if (!Array.isArray(value) || !value.every(isPattern))
		throw new Error("[400] skip_checks is a list of patterns, like *.md or docs/ ([] for nothing)");
	return [...new Set((value as string[]).map((pattern) => pattern.trim()))];
}

/** A review policy from settings' arguments, falling back to `base` for any left out. */
export function policyFrom(args: Args, base: ReviewPolicy): ReviewPolicy {
	const required = typeof args.required === "number" ? args.required : base.required;
	if (!Number.isInteger(required) || required < 0)
		throw new Error("[400] required is a whole number of approvals, 0 for none");
	const grants = args.grants !== undefined ? validGrants(args.grants) : base.grants;
	return {
		required,
		vetoes: Array.isArray(args.vetoes) ? (args.vetoes as string[]) : base.vetoes,
		escalate: Array.isArray(args.escalate) ? (args.escalate as ReviewPolicy["escalate"]) : base.escalate,
		// Without grants, every role keeps its default holders.
		...(grants && Object.keys(grants).length ? { grants } : {}),
	};
}

/** Parses settings' github ("owner/name", or "" for none). Refused unless GitHive's App is installed there. */
export async function githubFrom(ctx: ToolContext, value: unknown): Promise<{ repo: string } | null> {
	if (value === "" || value === null) return null;
	if (typeof value !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.trim()))
		throw new Error('[400] github is "owner/name", or "" for none');
	if (!ctx.github) throw new Error("[501] GitHub isn't set up on this GitHive (its App's ID and key)");
	const repo = value.trim();
	if (!(await ctx.github(repo)))
		throw new Error(`[409] GitHive's GitHub app isn't installed on ${repo}: install it there first`);
	return { repo };
}

export function checksFrom(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("[400] verify is a list of commands, [] for none");
	return value.filter((command): command is string => typeof command === "string" && !!command.trim());
}

/** Validates role grants: each role maps to a list of who may vote as it. */
function validGrants(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("[400] grants maps each role to who may vote as it");
	const grants: Record<string, string[]> = {};
	for (const [role, who] of Object.entries(value)) {
		if (!Array.isArray(who) || !who.every((holder) => typeof holder === "string" && holder.trim()))
			throw new Error(
				`[400] grants.${role} is a list: agent names, "person:*", "person:<who>", "service:<id>", a team "@<org>/<team>" or "githive"`,
			);
		grants[role] = who.map((holder) => holder.trim());
	}
	return grants;
}
