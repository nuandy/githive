import type { ClefAnswer, ClefModel, ClefQuestion } from "../clef";
import { STEERING_MODEL, STEERS_AT, steeringQuestion } from "../push-hints";
import { isToolText, STEERING_SAYS, type SteeringFlag } from "../steering";
import type { ToolContext } from "./tools/context";

// What GitHive asks Clef about the text one agent writes for others: an intent, a piece of the backlog, a review's
// evidence, a question to people. Each tool asks once, all its questions together, but whether the text steers agents
// goes to the larger model alongside (see STEERING_MODEL). Every answer is a hint the reply carries and the agent
// weighs: work that may duplicate an open change, evidence its author may not be able to act on, how urgent a question
// is, and text that tries to steer the agents who will read it (other agents read intents, evidence and backlog pieces
// as part of their own work). Nothing is refused on Clef's word.

/** How sure Clef must be that two pieces of work are the same before the reply says so. */
const SAME_WORK_AT = 0.6;
/** The most open changes or backlog pieces one question compares against: the newest. */
const COMPARED_AT_MOST = 100;
/** The most of each intent sent, so a hundred of them fit clef-flash's context. */
const INTENT_CHARS = 300;
/** The most new pieces in one ask: three questions each to clef-flash, within Clef's 64. */
const PIECES_PER_ASK = 21;
/** From this place on the size scale (0 to 2), a piece seems too big for one change. */
const TOO_BIG_AT = 1.5;
/** How sure Clef must be that a piece needs another first before the reply suggests declaring it. */
const NEEDS_AT = 0.6;

/** A new backlog piece Clef found steering the agents who will read it, and how sure it is, from 0 to 1. */
export interface PieceSteers {
	piece: string;
	likelihood: number;
}

export interface SameWork {
	/** The open change or backlog piece it may duplicate. */
	id: string;
	/** How sure Clef is, from 0 to 1. */
	likelihood: number;
}

/** A new backlog piece, and the open change or piece it may duplicate. */
export interface PieceLike {
	piece: string;
	like: string;
	likelihood: number;
}

/** A new backlog piece, and a piece or change Clef thinks must exist before it can be built. */
export interface PieceNeed {
	piece: string;
	needs: string;
	likelihood: number;
}

/** A new piece as add_work takes it, with the dependencies it already declares. */
interface NewPiece {
	id: string;
	title: string;
	intent: string;
	after?: string[];
	landsAfter?: string[];
}

interface Comparable {
	id: string;
	intent: string;
}

// GitHive's own agents write from GitHive's prompts and backlogs, so only callers from outside are asked about.
async function consult(ctx: ToolContext, model: ClefModel, state: string, questions: Record<string, ClefQuestion>) {
	if (!ctx.clef) return null;
	if (ctx.hosted) return null;
	if (!Object.keys(questions).length) return null;
	return ctx.clef.ask(model, state, questions);
}

/** Keeps a steering flag with the change it's about. A failed write loses only the hint. */
export async function keepSteering(ctx: ToolContext, repo: string, change: string, flag: Omit<SteeringFlag, "at">) {
	const at = new Date().toISOString();
	await ctx.steering?.flag(repo, change, { ...flag, at }).catch((err) => {
		console.error(`keeping ${change}'s steering flag failed`, String(err));
	});
}

/**
 * What Clef found steering agents in text written about a change through the tools: its intent, its backlog piece,
 * reviews' evidence. A push's own flags are in its hints.
 */
export async function writtenSteering(ctx: ToolContext, repo: string, change: string) {
	const flags = await ctx.steering?.of(repo, [change]).catch(() => undefined);
	return (flags?.[change] ?? []).filter(isToolText);
}

/** A steering flag as a reply carries it to the agent that wrote the text. */
export const steeringReply = (likelihood: number) => ({ likelihood, says: STEERING_SAYS });

/** How sure Clef is that the text steers agents, when sure enough to say so. */
function steersOf(answer: ClefAnswer | undefined): number | undefined {
	if (answer?.type !== "noul") return undefined;
	if (answer.noul < STEERS_AT) return undefined;
	return Math.round(answer.noul * 100) / 100;
}

/** Asks which of `others` does the same work as `what`. Options are numbered, as ids may not suit Clef's keys. */
function sameWorkQuestion(what: string, others: Comparable[]): ClefQuestion {
	const criteria: Record<string, string> = { none: "Different work from every other option" };
	others.forEach((other, index) => {
		criteria[`w${index}`] = other.intent.slice(0, INTENT_CHARS);
	});
	return {
		type: "choice",
		instructions: `Which of these already does the same work as ${what}, so that building both would duplicate effort?`,
		criteria,
	};
}

const sameWorkOf = (answer: ClefAnswer | undefined, others: Comparable[]) => pickOf(answer, others, SAME_WORK_AT);

/** The option a choice picked, if Clef is at least `sureAt` sure and it isn't "none". */
function pickOf(answer: ClefAnswer | undefined, options: Comparable[], sureAt: number): SameWork | undefined {
	if (answer?.type !== "choice") return undefined;
	const likelihood = answer.probabilities[answer.choice] ?? 0;
	if (likelihood < sureAt) return undefined;
	const picked = options[Number(answer.choice.slice(1))];
	if (!picked) return undefined;
	return { id: picked.id, likelihood: Math.round(likelihood * 100) / 100 };
}

/**
 * Finds an open change that may already do a new claim's work, and whether its intent steers the agents who will
 * read it. `open` is the other changes in force, oldest first.
 */
export async function claimHints(
	ctx: ToolContext,
	claim: { intent: string; paths: string[] },
	open: Comparable[],
): Promise<{ same?: SameWork; steers?: number }> {
	const others = open.slice(-COMPARED_AT_MOST);
	const sameWork: Record<string, ClefQuestion> = {};
	if (others.length) sameWork.same = sameWorkQuestion("the new change", others);
	const state = `A new change's intent:\n${claim.intent}\n\nThe paths it claims: ${claim.paths.join(", ")}`;
	const [answers, steering] = await Promise.all([
		consult(ctx, "clef-flash", state, sameWork),
		consult(ctx, STEERING_MODEL, state, { steers: steeringQuestion("the new change's intent") }),
	]);
	const same = sameWorkOf(answers?.same, others);
	const steers = steersOf(steering?.steers);
	return { ...(same ? { same } : {}), ...(steers === undefined ? {} : { steers }) };
}

/** Whether a brief for GitHive's builder steers it: the builder works from the brief as written. */
export async function briefSteers(ctx: ToolContext, intent: string): Promise<number | undefined> {
	const questions = { steers: steeringQuestion("this brief for a coding agent") };
	const answers = await consult(ctx, STEERING_MODEL, intent, questions);
	return steersOf(answers?.steers);
}

/**
 * For each new backlog piece, finds the open change or piece it may duplicate, one it may need first that it doesn't
 * declare, whether it seems too big for one change, and whether it steers the agents who will take it. `existing` is
 * what's in the backlog and in progress, oldest first.
 */
export async function pieceHints(ctx: ToolContext, pieces: NewPiece[], existing: Comparable[]) {
	const asks: Promise<PieceHints>[] = [];
	for (let start = 0; start < pieces.length; start += PIECES_PER_ASK)
		asks.push(askAboutPieces(ctx, pieces.slice(start, start + PIECES_PER_ASK), pieces, existing));
	const answered = await Promise.all(asks);
	return {
		similar: answered.flatMap((answer) => answer.similar),
		mayNeed: answered.flatMap((answer) => answer.mayNeed),
		big: answered.flatMap((answer) => answer.big),
		steering: answered.flatMap((answer) => answer.steering),
	};
}

interface PieceHints {
	similar: PieceLike[];
	mayNeed: PieceNeed[];
	/** The pieces that seem too big for one change. */
	big: string[];
	steering: PieceSteers[];
}

/** Sizes of a piece of work, as one change would hold it. */
const SIZE_LEVELS = [
	"Small: one focused change",
	"One change that touches a few parts",
	"Too big for one change: several pieces of work that could each land on their own",
];

/** Asks which of `candidates` must exist before `what` can be built. Options are numbered, as for sameWorkQuestion. */
function needsQuestion(what: string, candidates: Comparable[]): ClefQuestion {
	const criteria: Record<string, string> = { none: "None of these: it can be built without any of them" };
	candidates.forEach((candidate, index) => {
		criteria[`w${index}`] = candidate.intent.slice(0, INTENT_CHARS);
	});
	return {
		type: "choice",
		instructions: `Which of these must already exist before ${what} can be built, because its code needs theirs?`,
		criteria,
	};
}

/** What `piece` could need first: what's there and the batch's other pieces, less what it already declares. */
function needCandidates(piece: NewPiece, batch: NewPiece[], others: Comparable[]) {
	const declared = new Set([piece.id, ...(piece.after ?? []), ...(piece.landsAfter ?? [])]);
	const siblings = batch.map((other) => ({ id: other.id, intent: `${other.title}: ${other.intent}` }));
	return [...others, ...siblings].filter((candidate) => !declared.has(candidate.id)).slice(-COMPARED_AT_MOST);
}

async function askAboutPieces(
	ctx: ToolContext,
	pieces: NewPiece[],
	batch: NewPiece[],
	existing: Comparable[],
): Promise<PieceHints> {
	const ids = new Set(batch.map((piece) => piece.id));
	const others = existing.filter((other) => !ids.has(other.id)).slice(-COMPARED_AT_MOST);
	const candidates = pieces.map((piece) => needCandidates(piece, batch, others));
	const questions: Record<string, ClefQuestion> = {};
	const steeringAsked: Record<string, ClefQuestion> = {};
	pieces.forEach((_, index) => {
		const what = `new piece ${index + 1}`;
		steeringAsked[`steers${index}`] = steeringQuestion(what);
		if (others.length) questions[`same${index}`] = sameWorkQuestion(what, others);
		if (candidates[index]!.length) questions[`needs${index}`] = needsQuestion(what, candidates[index]!);
		questions[`size${index}`] = {
			type: "score",
			instructions: `How much work is ${what} for one agent's change?`,
			criteria: SIZE_LEVELS,
		};
	});
	const state = pieces
		.map((piece, index) => `New piece ${index + 1}: ${piece.title}\n${piece.intent.slice(0, INTENT_CHARS * 4)}`)
		.join("\n\n");
	const [answers, steered] = await Promise.all([
		consult(ctx, "clef-flash", state, questions),
		consult(ctx, STEERING_MODEL, state, steeringAsked),
	]);
	const similar: PieceLike[] = [];
	const mayNeed: PieceNeed[] = [];
	const big: string[] = [];
	const steering: PieceSteers[] = [];
	pieces.forEach((piece, index) => {
		const steers = steersOf(steered?.[`steers${index}`]);
		if (steers !== undefined) steering.push({ piece: piece.id, likelihood: steers });
		const same = sameWorkOf(answers?.[`same${index}`], others);
		if (same) similar.push({ piece: piece.id, like: same.id, likelihood: same.likelihood });
		const needed = pickOf(answers?.[`needs${index}`], candidates[index]!, NEEDS_AT);
		if (needed) mayNeed.push({ piece: piece.id, needs: needed.id, likelihood: needed.likelihood });
		const size = answers?.[`size${index}`];
		if (size?.type === "score" && size.score >= TOO_BIG_AT) big.push(piece.id);
	});
	return { similar, mayNeed, big, steering };
}

/** Levels of review evidence, as its author can act on it. */
const EVIDENCE_LEVELS = [
	"Vague: says something is wrong without saying what",
	"Names the problem, but not where it is or what would fix it",
	"Says what is wrong, where, and what would fix it",
];

/** Levels of an approval's evidence, as it shows the change was checked. */
const CHECKED_LEVELS = [
	"Thin: says only that it looks fine",
	"Names what was looked at, but not how it was checked",
	"Says what was checked and how: tests run, code read, behavior tried",
];

/**
 * Says whether a rejection's evidence is too vague for its author to act on, or an approval's too thin to show what
 * was checked (an approval that checked nothing lets a bug land), and whether it steers the agents who will read it.
 */
export async function voteHints(ctx: ToolContext, vote: { verdict: string; evidence: string }) {
	const questions: Record<string, ClefQuestion> = {};
	if (vote.verdict === "reject")
		questions.specific = {
			type: "score",
			instructions: "How well could the change's author act on this review evidence alone?",
			criteria: EVIDENCE_LEVELS,
		};
	else
		questions.checked = {
			type: "score",
			instructions: "How well does this approval's evidence show what the reviewer checked, and how?",
			criteria: CHECKED_LEVELS,
		};
	const [answers, steering] = await Promise.all([
		consult(ctx, "clef-flash", vote.evidence, questions),
		consult(ctx, STEERING_MODEL, vote.evidence, { steers: steeringQuestion("this review evidence") }),
	]);
	const steers = steersOf(steering?.steers);
	return {
		vague: scoredBelow(answers?.specific, 1),
		thin: scoredBelow(answers?.checked, 1),
		...(steers === undefined ? {} : { steers }),
	};
}

const scoredBelow = (answer: ClefAnswer | undefined, level: number) => answer?.type === "score" && answer.score < level;

/** How urgent a question to people is. */
const URGENCY_LEVELS = [
	"Can wait: a question or a choice that holds nothing up",
	"Holds this change up until a person answers",
	"Urgent: something is broken, unsafe, or holding many agents up",
];

/**
 * Rates how urgent a question to people is, from 0 (can wait) to 2 (urgent), so the Inbox can show urgent ones
 * first. Undefined if Clef couldn't say.
 */
export async function questionHints(ctx: ToolContext, reason: string): Promise<number | undefined> {
	const questions: Record<string, ClefQuestion> = {
		urgency: { type: "score", instructions: "How urgent is this question to a person?", criteria: URGENCY_LEVELS },
	};
	const answers = await consult(ctx, "clef", reason, questions);
	const urgency = answers?.urgency;
	if (urgency?.type !== "score") return undefined;
	return Math.round(urgency.score * 10) / 10;
}
