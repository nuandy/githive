/** Git workflow guidance shared by the builder and reviewer prompts. */
export const gitGuidance = (branch: string) =>
	[
		"Git in GitHive",
		"- Never rewrite history that has been pushed: do not amend or rebase pushed commits, and never " +
			"force-push. Make a new commit instead.",
		`- The project's branch is ${branch}. Bring in its updates with \`git merge base/${branch}\` (after ` +
			"fetch_base), not a rebase.",
		`- To see your own changes, diff against the commit where your change started (its merge base with ${branch}), ` +
			`not against the moving \`base/${branch}\` tip. Reviewers: \`git diff <baseCommit> HEAD\` shows the ` +
			"pinned change.",
		`- Avoid commands that throw away uncommitted work (\`git reset --hard\`, \`git checkout -- .\`, \`git ` +
			`clean -fdx\`) unless that is intended.`,
	].join("\n");

/**
 * A word as a shell reads it: as it is when that's safe, else in single quotes. Every command GitHive gives an agent
 * builds its branch names and paths with it.
 */
export const shellWord = (word: string) =>
	/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
