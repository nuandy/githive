import { BRANCH_PATTERN, type BranchRule } from "../branch-rules";
import { SKIP_PATTERN } from "../check-scope";
import { GITHUB_SYNCS, type GitHubSettings, type GitHubSync, NEW_CONNECTION_SYNC } from "../github-settings";
import type { ReviewPolicy } from "../votes";
import type { Args, ToolContext } from "./context";
import { fail } from "../../errors";

// Parsing the settings tool's input into the registry's policy, checks and branch rules.

/** The settings arguments for the GitHub link. */
export const GITHUB_FIELDS = ["github", "github_sync", "github_trust"] as const;

/** The settings arguments that make up the review policy. */
export const POLICY_FIELDS = ["required", "vetoes", "escalate", "grants"] as const;

/** Parses branch_rules from settings: a pattern each, with the policy fields and checks it overrides. */
export function branchRulesFrom(value: unknown, base: ReviewPolicy): BranchRule<ReviewPolicy>[] {
	if (!Array.isArray(value)) fail(400, "branch_rules is a list of rules: each a pattern, and what it changes");
	return value.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			fail(400, `branch_rules[${index}] is a rule: a pattern, and what it changes`);
		const rule = raw as Args;
		const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
		if (!pattern || !BRANCH_PATTERN.test(pattern))
			fail(400, `branch_rules[${index}].pattern is a branch name, with * for any run of characters (feature/*)`);
		// Keep only the fields the rule sets, so the rest follow the repo's settings as they change.
		const full = policyFrom(rule, base);
		const policy = Object.fromEntries(
			POLICY_FIELDS.filter((field) => rule[field] !== undefined).map((field) => [field, full[field]]),
		) as Partial<ReviewPolicy>;
		const verify = rule.verify === undefined ? undefined : checksFrom(rule.verify);
		if (!Object.keys(policy).length && !verify)
			fail(
				400,
				`branch_rules[${index}] (${pattern}) changes nothing: set required, vetoes, ` + "escalate, grants or verify",
			);
		return { pattern, ...(Object.keys(policy).length ? { policy } : {}), ...(verify ? { verify } : {}) };
	});
}

/** Parses skip_checks: patterns like *.md or docs/ for files the checks skip. */
export function skipPatternsFrom(value: unknown): string[] {
	const isPattern = (item: unknown) => typeof item === "string" && SKIP_PATTERN.test(item.trim());
	if (!Array.isArray(value) || !value.every(isPattern))
		fail(400, "skip_checks is a list of patterns, like *.md or docs/ ([] for nothing)");
	return [...new Set((value as string[]).map((pattern) => pattern.trim()))];
}

/** A review policy from settings' arguments, falling back to `base` for any left out. */
export function policyFrom(args: Args, base: ReviewPolicy): ReviewPolicy {
	const required = typeof args.required === "number" ? args.required : base.required;
	if (!Number.isInteger(required) || required < 0) fail(400, "required is a whole number of approvals, 0 for none");
	const grants = args.grants !== undefined ? validGrants(args.grants) : base.grants;
	return {
		required,
		vetoes: Array.isArray(args.vetoes) ? (args.vetoes as string[]) : base.vetoes,
		escalate: Array.isArray(args.escalate) ? (args.escalate as ReviewPolicy["escalate"]) : base.escalate,
		// Without grants, every role keeps its default holders.
		...(grants && Object.keys(grants).length ? { grants } : {}),
	};
}

/**
 * Parses settings' github ("owner/name", or "" for none), github_sync ("mirror" or "pr") and github_trust, against
 * the repo's current link. A repo newly connected takes NEW_CONNECTION_SYNC and trusts GitHub's changes. Refused
 * unless GitHive's App is installed there. Undefined when none of them is given.
 */
export async function githubFrom(
	ctx: ToolContext,
	args: Args,
	current: GitHubSettings | undefined,
): Promise<GitHubSettings | null | undefined> {
	const { github: value, github_sync: sync, github_trust: trust } = args;
	if (value === undefined && sync === undefined && trust === undefined) return undefined;
	if (sync !== undefined && !GITHUB_SYNCS.includes(sync as GitHubSync))
		fail(400, 'github_sync is "mirror" (main goes to GitHub\'s main) or "pr" (through a pull request)');
	if (trust !== undefined && typeof trust !== "boolean") fail(400, "github_trust is true or false");
	if (value === "" || value === null) {
		if (sync !== undefined || trust !== undefined) fail(400, "github_sync and github_trust need a GitHub repo");
		return null;
	}
	const link = value === undefined ? current : await connected(ctx, value, current);
	if (!link) fail(409, 'connect a GitHub repo first: set github ("owner/name")');
	// What isn't given stays as the link has it.
	const next: GitHubSettings = { repo: link.repo };
	const mode = (sync as GitHubSync | undefined) ?? link.sync;
	if (mode) next.sync = mode;
	const trusted = (trust as boolean | undefined) ?? link.trust;
	if (trusted !== undefined) next.trust = trusted;
	return next;
}

// The link `value` names: the current one if it's the same repo, else a new connection, which must have the App.
async function connected(ctx: ToolContext, value: unknown, current: GitHubSettings | undefined) {
	if (typeof value !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.trim()))
		fail(400, 'github is "owner/name", or "" for none');
	const repo = value.trim();
	if (current?.repo === repo) return current;
	if (!ctx.github) fail(501, "GitHub isn't set up on this GitHive (its App's ID and key)");
	if (!(await ctx.github(repo))) fail(409, `GitHive's GitHub app isn't installed on ${repo}: install it there first`);
	return { repo, sync: NEW_CONNECTION_SYNC, trust: true };
}

export function checksFrom(value: unknown): string[] {
	if (!Array.isArray(value)) fail(400, "verify is a list of commands, [] for none");
	return value.filter((command): command is string => typeof command === "string" && !!command.trim());
}

/** Validates role grants: each role maps to a list of who may vote as it. */
function validGrants(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(400, "grants maps each role to who may vote as it");
	const grants: Record<string, string[]> = {};
	for (const [role, who] of Object.entries(value)) {
		if (!Array.isArray(who) || !who.every((holder) => typeof holder === "string" && holder.trim()))
			fail(
				400,
				`grants.${role} is a list: agent names, "person:*", "person:<who>", "service:<id>", ` +
					`a team "@<org>/<team>" or "githive"`,
			);
		grants[role] = who.map((holder) => holder.trim());
	}
	return grants;
}
