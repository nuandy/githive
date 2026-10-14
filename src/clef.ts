// Clef, Cloudflare's decision models on Workers AI. A question gets back a probability for each allowed answer, never
// text, so GitHive can ask about what agents write (does it duplicate open work, does it try to steer the agents who
// read it) and pass the answer on as a hint. Nothing waits on Clef for long: a failed or slow answer is no answer, and
// the call goes on without the hint.

/** clef-flash answers in tens of milliseconds, for calls agents make often; clef is slower and more accurate. */
export type ClefModel = "clef" | "clef-flash";

/** A typed question: yes or no, one of several named answers, or a place on an ordered scale. */
export type ClefQuestion =
	| { type: "noul"; instructions: string }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

/** A noul's probability of yes; a choice's pick and each answer's probability; a score's weighted place. */
export type ClefAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface Clef {
	/** Answers by question id, or null if Clef couldn't answer in time. `images` are data URLs, at most 4. */
	ask(
		model: ClefModel,
		state: string,
		questions: Record<string, ClefQuestion>,
		images?: string[],
	): Promise<Record<string, ClefAnswer> | null>;
	/** The same Clef, its calls tagged with the repo they're about, so a repo's owner can see what it used. */
	forRepo?(repo: string): Clef;
}

/**
 * How a repo's Workers AI calls are tagged, by the Worker that made them (bench and production share an account and
 * name repos alike): letters, digits and : - . / @ only, at most 50 characters.
 */
export const repoTag = (worker: string, repo: string) =>
	`${worker}:${repo}`.replace(/[^A-Za-z0-9:./@-]/g, "-").slice(0, 50);

/** How long a call waits for each model before going on without its answer. */
const ANSWER_WITHIN_MS: Record<ClefModel, number> = { "clef-flash": 1_500, clef: 4_000 };

type Run = (model: string, input: unknown, options: { tags?: string[] }) => Promise<unknown>;

/** Clef through the Worker's Workers AI binding. Named for `worker`, it tags each repo's calls (forRepo). */
export function clefOn(ai: Ai, worker?: string, tags: string[] = []): Clef {
	const run = ai.run.bind(ai) as unknown as Run;
	return {
		...(worker ? { forRepo: (repo: string) => clefOn(ai, worker, [repoTag(worker, repo)]) } : {}),
		ask: async (model, state, questions, images) => {
			const input = { model, state, questions, ...(images?.length ? { images: images.slice(0, 4) } : {}) };
			const asking = run(`@cf/cloudflare/${model}`, input, tags.length ? { tags } : {});
			const answer = await withinMs(asking, ANSWER_WITHIN_MS[model]).catch((err) => {
				console.error(`asking ${model} failed`, String(err));
				return undefined;
			});
			// Null only when the answer came too late; a failure is logged above.
			if (answer === null) console.error(`${model} gave no answer within ${ANSWER_WITHIN_MS[model]} ms`);
			return (answer as { answers?: Record<string, ClefAnswer> } | null | undefined)?.answers ?? null;
		},
	};
}

function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
