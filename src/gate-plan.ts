import type { Slice } from "./types";

// Pure decisions for the integration gate, kept separate so they can be tested
// without containers.

export interface CheckResult {
	command: string;
	exitCode: number;
	output: string;
}

export interface GateResult {
	passed: boolean;
	/** The slice commit that was checked. */
	head: string;
	/** The task base commit it was merged onto. */
	baseHead: string;
	/** Set when the slice didn't merge cleanly onto the base. */
	mergeConflict?: string[];
	results: CheckResult[];
	at: string;
}

/**
 * Contract test files to leave out of a gate run: those that belong only to
 * slices not yet integrated (other than the one being checked). They can't
 * pass until those slices land; everything else should pass now.
 */
export function gateExclusions(slices: Pick<Slice, "id" | "status" | "tests">[], sliceId: string) {
	const needed = new Set<string>();
	const pending = new Set<string>();
	for (const s of slices) {
		const tests = s.tests ?? [];
		if (s.id === sliceId || s.status === "integrated") tests.forEach((t) => needed.add(t));
		else tests.forEach((t) => pending.add(t));
	}
	return [...pending].filter((t) => !needed.has(t));
}

/** What a builder is told when the combined code fails the gate. */
export function gateFeedback(result: GateResult, excluded: string[]) {
	if (result.mergeConflict)
		return `Review approved your slice, but it no longer merges cleanly onto the task base: conflicts in ${result.mergeConflict.join(", ")}. Call fetch_base, merge base/main, resolve the conflicts inside your lane, run the checks, then commit_and_push and finish.`;
	const failed = result.results.find((r) => r.exitCode !== 0);
	return [
		"Review approved your slice, but the combined code (your slice merged onto the task base, with everything integrated so far) fails the task's checks.",
		failed ? `\nFailing command: ${failed.command} (exit code ${failed.exitCode})\n${failed.output}` : "",
		excluded.length ? `\nLeft out because their slices aren't integrated yet: ${excluded.join(", ")}.` : "",
		"\nFix it within your lane. If a contract is wrong (for example, a contract test that can't type-check), propose a fix with propose_contract_change. Then commit_and_push and finish.",
	].join("\n");
}
