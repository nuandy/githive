// Settings by branch. A repo's review policy and checks apply to every branch unless a branch rule overrides
// them. A rule sets only the fields it changes, so the rest keep following the repo's settings. The first
// matching rule wins. The module has no imports so the dashboard can use it too.

/** Overrides for the branches a pattern names. Unset `verify` keeps the repo's checks; [] means none. */
export interface BranchRule<Policy = Record<string, unknown>> {
	pattern: string;
	policy?: Partial<Policy>;
	verify?: string[];
}

/** A branch name's characters, plus * for any run of them, slashes included. */
export const BRANCH_PATTERN = /^[A-Za-z0-9._/*-]+$/;

export function matchesBranch(pattern: string, branch: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(branch);
}

/** The first rule that names `branch`. The project's branch never has one; it always takes the repo's settings. */
export function ruleFor<Policy>(
	rules: BranchRule<Policy>[] | undefined,
	branch: string,
	project: string,
): BranchRule<Policy> | undefined {
	if (branch === project) return undefined;
	return rules?.find((rule) => matchesBranch(rule.pattern, branch));
}

export function settingsForBranch<Policy extends object>(
	repo: { policy: Policy; verify: string[]; rules?: BranchRule<Policy>[]; project: string },
	branch: string,
): { policy: Policy; verify: string[]; rule?: string } {
	const rule = ruleFor(repo.rules, branch, repo.project);
	if (!rule) return { policy: repo.policy, verify: repo.verify };
	return {
		policy: { ...repo.policy, ...rule.policy } as Policy,
		verify: rule.verify ?? repo.verify,
		rule: rule.pattern,
	};
}
