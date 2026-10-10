/**
 * The branch a project's changes merge into: the repo's default branch, recorded when the project was opened.
 * Older records without a branch used main.
 */
export const projectBranch = (recorded: { branch?: string } | null | undefined) => recorded?.branch ?? "main";
