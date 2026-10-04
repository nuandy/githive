// Repo-relative path rules, shared by everything that takes a path from an agent.

/** The rule every repo path follows: relative, and never climbing out of the repo with "..". */
export const staysInRepo = (path: string) => !path.startsWith("/") && !path.split("/").includes("..");

/** Stricter: also no empty or "." segments, so a path has one spelling (not "a//b", "./a" or "a/"). */
export const isPlainPath = (path: string) => staysInRepo(path) && path.split("/").every((segment) => segment && segment !== ".");
