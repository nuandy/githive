import type { Clef, ClefQuestion } from "../clef";
import type { CheckResult } from "./merge-types";

// What Clef makes of a batch's failed checks, asked once when the batch first fails and while the search for the
// change that fails it runs (see checkBatch): whether something outside the code seems to have failed them, and which
// change in the batch seems most likely to have. Both are hints. The search runs and finds what it would without
// them; Clef's suspect is kept beside what it found, on each change put out, so how often it's right can be measured,
// and a failure that seems to be the environment's is said to the change's agent, since a new commit won't fix it.

/** Clef's reading of a batch's failure. */
export interface FailureHint {
	/** How likely it is that something outside the code failed the checks, from 0 to 1. */
	environment?: number;
	/** The change in the batch Clef found most likely to fail them, and how sure it was. */
	suspect?: { change: string; likelihood: number };
}

/** How sure Clef must be that the environment failed the checks before its agent is told. */
const ENVIRONMENT_AT = 0.7;

/** Whether Clef found it likely that the environment failed an outcome's checks. */
export const likelyEnvironment = (outcome: { environment?: number }) => (outcome.environment ?? 0) >= ENVIRONMENT_AT;

/** How much of each failed command's output Clef reads (its end), and of all of them. */
const OUTPUT_CHARS = 3_000;
const STATE_CHARS = 9_000;
/** How much of each change's intent, and how many of its files, the suspect question names. */
const INTENT_CHARS = 200;
const FILES_NAMED = 8;

const ENVIRONMENT: ClefQuestion = {
	type: "noul",
	instructions:
		"Did something outside the code being checked make these checks fail, such as the network, a timeout, " +
		"running out of memory or disk, a missing tool, or installing dependencies?",
};

/** A change in the batch, as the suspect question names it. */
export interface Suspectable {
	change: string;
	intent: string;
	files: string[];
}

/** Asks Clef about a batch's failed `results`. Empty when Clef doesn't answer, or the batch only failed to merge. */
export async function failureHints(
	clef: Clef,
	batch: Suspectable[],
	results: CheckResult[],
	skip: (result: CheckResult) => boolean,
): Promise<FailureHint> {
	const failed = results.filter((result) => result.exitCode !== 0 && !skip(result));
	if (!failed.length) return {};
	const state = failed
		.map((result) => `$ ${result.command} (exited ${result.exitCode})\n${result.output.slice(-OUTPUT_CHARS)}`)
		.join("\n\n")
		.slice(0, STATE_CHARS);
	const questions: Record<string, ClefQuestion> = { environment: ENVIRONMENT };
	if (batch.length > 1) questions.suspect = suspectQuestion(batch);
	const answers = await clef.ask("clef-flash", state, questions);
	if (!answers) return {};
	const hint: FailureHint = {};
	const environment = answers.environment;
	if (environment?.type === "noul") hint.environment = rounded(environment.noul);
	const suspect = answers.suspect;
	if (suspect?.type === "choice") {
		const named = batch[Number(suspect.choice.slice(1))];
		if (named && suspect.choice.startsWith("c"))
			hint.suspect = { change: named.change, likelihood: rounded(suspect.probabilities[suspect.choice] ?? 0) };
	}
	return hint;
}

// Options are numbered, as change names may not suit Clef's keys.
function suspectQuestion(batch: Suspectable[]): ClefQuestion {
	const criteria: Record<string, string> = { unclear: "No change in particular" };
	batch.forEach((each, index) => {
		const files = each.files.slice(0, FILES_NAMED).join(", ");
		criteria[`c${index}`] = `${each.intent.split("\n")[0]!.slice(0, INTENT_CHARS)} (changes ${files})`;
	});
	return {
		type: "choice",
		instructions: "These changes were checked together, and the checks failed. Which change most likely failed them?",
		criteria,
	};
}

const rounded = (value: number) => Math.round(value * 100) / 100;
