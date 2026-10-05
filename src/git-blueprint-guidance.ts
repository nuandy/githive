/** Shared Git workflow guidance included verbatim in builder and reviewer instructions. */
export const GIT_IN_BLUEPRINT = `Git in Blueprint
- Never rewrite history that has been pushed: do not amend or rebase pushed commits, and never force-push. Make a new commit instead.
- Bring in updates from the project's main with \`git merge base/main\` (after fetch_base), not a rebase.
- To see your own changes, diff against the commit where your change started (its merge base with main), not against the moving \`base/main\` tip. Reviewers: \`git diff <baseCommit> HEAD\` shows the pinned change.
- Avoid commands that throw away uncommitted work (\`git reset --hard\`, \`git checkout -- .\`, \`git clean -fdx\`) unless that is intended.`;
