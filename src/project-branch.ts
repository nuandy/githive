/**
 * The branch a project's changes merge into, as recorded on its task or
 * coordinator-free registry when it was opened (the repo's default branch:
 * main, master, ...). Records made before Blueprint read it all used main.
 */
export const projectBranch = (recorded: { branch?: string } | null | undefined) => recorded?.branch ?? "main";
