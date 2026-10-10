// Settings by branch: a repo's review policy and checks are its project
// branch's, and any other branch's unless a branch rule says otherwise. A
// rule names branches by pattern (feature/*, release/*, or a name) and sets
// only what it changes: a policy field it leaves out, or checks it leaves
// unset, stay the repo's, so changing the repo's settings changes them too.
// The first rule that matches a branch is its rule.
//
// Pure, with no imports: the toolkit applies it, and the dashboard shows it.

/** Settings for the branches a pattern names: the policy fields it changes, and its checks (unset: the repo's; []: none). */
export interface BranchRule<Policy = Record<string, unknown>> {
	pattern: string;
	policy?: Partial<Policy>;
	verify?: string[];
}

/** A pattern's characters: a branch name's, and * for any run of them (slashes too). */
export const BRANCH_PATTERN = /^[A-Za-z0-9._/*-]+$/;

/** Whether `pattern` names `branch`: * stands for any run of characters, anything else for itself. */
export function matchesBranch(pattern: string, branch: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(branch);
}

/** The rule for `branch`: the first that names it, if any (the project's branch has none: it takes the repo's settings). */
export function ruleFor<Policy>(
	rules: BranchRule<Policy>[] | undefined,
	branch: string,
	project: string,
): BranchRule<Policy> | undefined {
	if (branch === project) return undefined;
	return rules?.find((rule) => matchesBranch(rule.pattern, branch));
}

/** A branch's settings: the repo's, with what its rule changes. */
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
