import { tally } from "./quorum";
import type { Slice, Task } from "./types";

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
 * slices not yet integrated (other than the ones being checked). They can't
 * pass until those slices land; everything else should pass now.
 */
export function gateExclusions(slices: Pick<Slice, "id" | "status" | "tests">[], checking: string | string[]) {
	const ids = new Set(Array.isArray(checking) ? checking : [checking]);
	const needed = new Set<string>();
	const pending = new Set<string>();
	for (const s of slices) {
		const tests = s.tests ?? [];
		if (ids.has(s.id) || s.status === "integrated") tests.forEach((t) => needed.add(t));
		else tests.forEach((t) => pending.add(t));
	}
	return [...pending].filter((t) => !needed.has(t));
}

/** What a builder is told when the combined code fails the gate. */
export function gateFeedback(result: GateResult, excluded: string[], groupedWith: string[] = []) {
	if (result.mergeConflict)
		return `Review approved your slice, but it no longer merges cleanly onto the task base: conflicts in ${result.mergeConflict.join(", ")}. Call fetch_base, merge what it fetched, resolve the conflicts inside your lane, run the checks, then commit_and_push and finish.`;
	const failed = result.results.find((r) => r.exitCode !== 0);
	return [
		"Review approved your slice, but the combined code (your slice merged onto the task base, with everything integrated so far) fails the task's checks.",
		groupedWith.length
			? `\nYour slice depends on (or is depended on by) ${groupedWith.join(", ")}, so this gate merged them together; the failure below is from the combined code.`
			: "",
		failed ? `\nFailing command: ${failed.command} (exit code ${failed.exitCode})\n${failed.output}` : "",
		excluded.length ? `\nLeft out because their slices aren't integrated yet: ${excluded.join(", ")}.` : "",
		"\nFix it within your claim, then commit_and_push and finish.",
	].join("\n");
}

/** A gate is authorized only by the current quorum or a human waiver for that exact head. */
const hasApprovedQuorum = (task: Task, slice: Slice, head: string) => slice.reviewHead === head && tally(task.review, slice).status === "approved";

const hasWaiver = (slice: Slice, head: string) => slice.reviewHead === head && !!slice.waivers?.some((waiver) => waiver.head === head);

/** Slices of a gate run that are still the ones waiting to integrate at these commits, or null when any has moved on. */
export function gateMembers(task: Task, sliceId: string, head: string, group: { slice: string; head: string }[] = []) {
	const members = [{ slice: sliceId, head }, ...group].map(({ slice: id, head: h }) => ({ s: task.slices.find((x) => x.id === id), h }));
	const valid = members.every(({ s, h }) =>
		s &&
		s.status === "building" &&
		s.reviewHead === h &&
		s.gate?.head === h &&
		(hasApprovedQuorum(task, s, h) || hasWaiver(s, h)),
	);
	return valid ? members.map(({ s }) => s!) : null;
}

/** Whether any other slice could still be integrated (and so might fix a failing gate). */
export function othersCanStillIntegrate(task: Task, slice: Slice) {
	return task.slices.some((s) => s !== slice && s.status === "building" && s.gate?.status !== "waiting");
}
