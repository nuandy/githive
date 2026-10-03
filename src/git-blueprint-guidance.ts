/** Shared Git workflow guidance included verbatim in builder and reviewer instructions. */
export const GIT_IN_BLUEPRINT = `Git in Blueprint
- Never rewrite history that has been pushed: do not amend or rebase pushed commits, and never force-push. Make a new commit instead.
- Bring in task-base updates with \`git merge base/main\`, not a rebase.
- To see your own changes, diff against the commit where your slice started (its merge base with the task base), not against the moving \`base/main\` tip. Reviewers: \`git diff <baseCommit> HEAD\` shows the pinned slice changes.
- Before proposing a change to a shared or contract file, read its current version with \`git show base/main:<path>\`.
- Avoid commands that throw away uncommitted work (\`git reset --hard\`, \`git checkout -- .\`, \`git clean -fdx\`) unless that is intended.`;
