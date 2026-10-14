// The shapes a Gate's callers send and receive: a change's checks, a batch's changes and the results.

export interface CheckResult {
	command: string;
	exitCode: number;
	output: string;
}

export interface GateResult {
	passed: boolean;
	/** The commit that was checked. */
	head: string;
	/** The project's branch commit it was merged onto. */
	baseHead: string;
	mergeConflict?: string[];
	results: CheckResult[];
	/** The checks couldn't run (a fetch or the container failed), which says nothing of the changes. */
	setupFailed?: true;
	at: string;
}

export interface CheckPlan {
	repo?: string;
	baseHead: string;
	branch?: string;
	base: { remote: string; token: string };
	/** The change's branch in its author's fork. */
	fork: { remote: string; token: string; ref: string };
	/** The batch's earlier changes, merged in order before the commit that is checked. */
	ahead?: { head: string; remote: string; token: string; ref?: string }[];
	checks: string[];
}

/** A warm-up on the project's branch. The checks are there for their install step. */
export interface WarmUp {
	repo: string;
	branch?: string;
	base: { remote: string; token: string };
	checks: string[];
}

/** A change in a batch, with the fork and token to read its branch. */
export interface BatchSource {
	change: string;
	remote: string;
	token: string;
	ref: string;
}

/** One change's checks, with the project's branch and the change's fork and commit. */
export interface ChangeCheck {
	repo?: string;
	branch?: string;
	base: { remote: string; token: string };
	fork: { remote: string; token: string; ref: string };
	head: string;
	checks: string[];
}

/** The project's branch in the repo, and the batch's base commit on it. */
export interface BatchBase {
	repo: string;
	branch: string;
	base: { remote: string; token: string };
	baseHead: string;
}
