// What Clef makes of a push to a change's branch (src/toolkit/clef-hints.ts asks about what agents write in tool
// calls). Other agents read a change's commit messages and the lines it adds through git log, blame and their own
// clones, so text in them that tries to steer those agents is pointed out; and the lines it adds are set against the
// change's intent, so a change doing something else, or more, is pointed out too. Each answer is a hint: kept for the
// change's `status`, where its reviewers see it as well, and told to its agent as a notice. Nothing is refused here,
// since the push has already happened, and nothing waits on it.

import type { Clef, ClefAnswer, ClefQuestion } from "./clef";
import { BLOB_TOO_LARGE, type HistorySource, type TreeEntry } from "./toolkit/branch-history";
import { steeringQuestion } from "./toolkit/clef-hints";
import { HOSTED_PREFIX } from "./toolkit/tools/repo";

/** A hint about one push, for its head only. */
export interface PushHint {
	kind: "steering" | "off_intent" | "beyond_intent" | "looks_broken";
	/** Where: "commit messages" or "added lines", for a steering hint. */
	in?: string;
	/** The preview a looks_broken hint is about (see preview-look.ts). */
	url?: string;
	/** One line an agent can read. */
	says: string;
	/** How sure Clef is, from 0 to 1. */
	likelihood: number;
}

/** A change's latest push hints, kept by the head they were worked out on. */
export interface KeptPushHints {
	head: string;
	hints: PushHint[];
}

/** How sure Clef must be that text steers agents: as high as for tool calls (see STEERS_AT in clef-hints.ts). */
const STEERS_AT = 0.9;
/** Below this, on a scale of 0 to 2, the added lines don't do what the intent says. */
const OFF_INTENT_BELOW = 0.8;
/** How sure Clef must be that the lines do more than the intent says. */
const BEYOND_AT = 0.8;
/** The most commits, files and characters one push sends: well within clef-flash's 24k tokens. */
const COMMITS_READ = 20;
const MESSAGE_CHARS = 4_000;
const FILES_READ = 20;
const FILE_BYTES = 64 * 1024;
const ADDED_CHARS = 40_000;
const INTENT_CHARS = 2_000;

/** A push placed on its branch: the change, its claim's intent and agent, and its files against its base. */
export interface PlacedPush {
	change: string;
	agent: string;
	intent?: string;
	head: string;
	base: string;
	files: string[];
}

/** What Clef makes of `push`, read from `source` (the agent's fork). Empty when there's nothing to say. */
export async function pushHints(clef: Clef, source: HistorySource, push: PlacedPush): Promise<PushHint[]> {
	// GitHive's own agents, all named githive-, write from GitHive's prompts (see consult in clef-hints.ts).
	if (push.agent.startsWith(HOSTED_PREFIX)) return [];
	const messages = await messagesSince(source, push.head, push.base);
	const added = await addedLines(source, push);
	if (!messages && !added) return [];
	const questions: Record<string, ClefQuestion> = {};
	if (messages) questions.messages = steeringQuestion("the commit messages");
	if (added) {
		questions.added = steeringQuestion(
			"any comment or text in the lines it adds",
			"Code that builds, tests or documents its own app's prompts is not that either.",
		);
		if (push.intent) {
			questions.matches = {
				type: "score",
				instructions: "How well do the lines it adds do what the change's intent says?",
				criteria: ["Unrelated to the intent", "Partly does what the intent says", "Does what the intent says"],
			};
			questions.beyond = {
				type: "noul",
				instructions:
					"Do the lines it adds also change behavior the intent doesn't mention, beyond what that work needs? " +
					"Tests, and small fixes the work needs, are not that.",
			};
		}
	}
	const state = [
		push.intent ? `The change's intent:\n${push.intent.slice(0, INTENT_CHARS)}` : "",
		messages ? `Its commit messages:\n${messages}` : "",
		added ? `The lines it adds, by file:\n${added}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const answers = await clef.ask("clef-flash", state, questions);
	return answers ? hintsFrom(answers) : [];
}

function hintsFrom(answers: Record<string, ClefAnswer>): PushHint[] {
	const hints: PushHint[] = [];
	for (const where of ["messages", "added"] as const) {
		const likelihood = nouled(answers[where]);
		if (likelihood === undefined || likelihood < STEERS_AT) continue;
		const what = where === "messages" ? "commit messages" : "added lines";
		hints.push({
			kind: "steering",
			in: what,
			says: `Its ${what} read as instructions to the agents who will read them`,
			likelihood,
		});
	}
	const matches = answers.matches;
	if (matches?.type === "score" && matches.score < OFF_INTENT_BELOW)
		hints.push({
			kind: "off_intent",
			says: "The lines it adds don't seem to do what its intent says",
			likelihood: rounded(1 - matches.score / 2),
		});
	const beyond = nouled(answers.beyond);
	if (beyond !== undefined && beyond >= BEYOND_AT)
		hints.push({ kind: "beyond_intent", says: "It seems to change more than its intent says", likelihood: beyond });
	return hints;
}

const nouled = (answer: ClefAnswer | undefined) => (answer?.type === "noul" ? rounded(answer.noul) : undefined);
const rounded = (value: number) => Math.round(value * 100) / 100;

/** The messages of the change's own commits, newest first, cut to MESSAGE_CHARS. */
async function messagesSince(source: HistorySource, head: string, base: string) {
	const chain = await source.log(head, COMMITS_READ, 0);
	const end = chain.findIndex((commit) => commit.hash === base);
	const own = end >= 0 ? chain.slice(0, end) : chain;
	return own
		.map((commit) => commit.message.trim())
		.filter(Boolean)
		.join("\n---\n")
		.slice(0, MESSAGE_CHARS);
}

/**
 * The lines each changed file has at the head and not at the base, as `+` lines under the file's path: what the
 * change adds, without a full diff. Binary and very large files are left out.
 */
async function addedLines(source: HistorySource, push: PlacedPush) {
	const [[head], [base]] = await Promise.all([source.log(push.head, 1, 0), source.log(push.base, 1, 0)]);
	if (!head || !source.readBlob) return "";
	const sections: string[] = [];
	let room = ADDED_CHARS;
	for (const path of push.files.slice(0, FILES_READ)) {
		if (room <= 0) break;
		const after = await textAt(source, head.treeHash, path);
		if (!after) continue;
		const before = base ? await textAt(source, base.treeHash, path) : null;
		const lines = newLines(before ?? "", after);
		if (!lines.length) continue;
		const section = `${path}\n${lines.map((line) => `+${line}`).join("\n")}`.slice(0, room);
		sections.push(section);
		room -= section.length;
	}
	return sections.join("\n\n");
}

/** Lines of `after` not in `before`, counting repeats, blank ones left out. */
function newLines(before: string, after: string) {
	const left = new Map<string, number>();
	for (const line of before.split("\n")) left.set(line, (left.get(line) ?? 0) + 1);
	const added: string[] = [];
	for (const line of after.split("\n")) {
		const count = left.get(line) ?? 0;
		if (count > 0) left.set(line, count - 1);
		else if (line.trim()) added.push(line);
	}
	return added;
}

async function textAt(source: HistorySource, tree: string, path: string) {
	const entry = await fileAt(source, tree, path);
	if (!entry) return null;
	const bytes = await source.readBlob!(entry.hash, FILE_BYTES);
	if (!bytes || bytes === BLOB_TOO_LARGE || bytes.length > FILE_BYTES || bytes.includes(0)) return null;
	return new TextDecoder().decode(bytes);
}

async function fileAt(source: HistorySource, tree: string, path: string): Promise<TreeEntry | null> {
	let entries = (await source.readTree(tree)) ?? [];
	const segments = path.split("/");
	for (const [index, name] of segments.entries()) {
		const entry = entries.find((each) => each.name === name);
		if (!entry) return null;
		if (index === segments.length - 1) return entry.type === "tree" ? null : entry;
		if (entry.type !== "tree") return null;
		entries = (await source.readTree(entry.hash)) ?? [];
	}
	return null;
}
