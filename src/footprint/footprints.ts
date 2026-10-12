import { type CommitMeta, filesBetween, type HistorySource, type TreeEntry } from "../toolkit/branch-history";
import { trailer } from "../toolkit/git-records";
import { LANDED_INTENT_CHARS } from "../toolkit/landing";
import { atMost } from "../toolkit/merge";
import { alteredNames, type AlteredName, NO_FILE } from "./compare";
import { compact, fileFacts, type FileFacts, languageOf, MAX_PARSE_CHARS } from "./extract";
import { importTargets } from "./resolve";
import type { Landing } from "./wording";

// Footprints read from Git: a pushed change's, from its fork, and a landed commit's alterations, from the project.
// The rest of the library is pure; this reads trees and blobs through a HistorySource (Artifacts' API), parses what
// changed, and keeps the facts by blob and path. Everything is capped by counts: a file that can't be read or parsed
// is skipped, and costs only a missed hint.

/** A name a change or a commit alters in one file. */
export type Alter = { file: string; altered: AlteredName };

/** A name of `file` the change's files use (its imported name, or "*" for the whole file), and where. */
export type UseOf = { file: string; name: string; at: { file: string; line: number }[] };

/** What footprints read facts through: those kept by blob and path, and what a batch has left to parse. */
export interface FactsSource {
	kept(keys: string[]): Promise<Record<string, FileFacts>>;
	keep(facts: Record<string, FileFacts>): Promise<void>;
	/** Parses and characters this batch may still spend. Counted, not timed: a Worker's clock stands still on CPU. */
	budget: { parses: number; chars: number };
}

/** The most TS/JS files read for one push, or for one landed commit. */
export const FILES_PER_PUSH = 50;
/** The most use sites kept for one name, and the most names one footprint uses. */
export const SITES_PER_NAME = 20;
export const USES_PER_FOOTPRINT = 100;
/** The most names one footprint, or one commit, alters. */
export const ALTERS_PER_FOOTPRINT = 200;
/** Signatures longer than this, compacted, are kept as their start and a hash of the whole. */
export const SIGNATURE_KEPT = 400;
const SIGNATURE_SHOWN = 200;
const HASHED = /… #([0-9a-f]{14})$/;
const READS_AT_ONCE = 6;

/** Where facts are kept: by blob, since blobs never change, and path, which sets the language and import targets. */
export const factsKey = (blob: string, path: string) => `${blob}:${path}`;

/**
 * A pushed change's footprint, read from its fork: the names it alters in each changed TS/JS file, base against head,
 * and the names its changed files use at the head, each resolved to a file that exists there. Null when its commits
 * can't be read.
 */
export async function changeFootprint(
	source: HistorySource,
	change: { head: string; base: string; files: string[] },
	facts: FactsSource,
): Promise<{ alters: Alter[]; uses: UseOf[] } | null> {
	const [[head], [base]] = await Promise.all([source.log(change.head, 1, 0), source.log(change.base, 1, 0)]);
	if (!head || !base) return null;
	const readTree = treeReader(source);
	const read = await readFiles(source, readTree, base.treeHash, head.treeHash, change.files, facts);
	const uses = new Map<string, UseOf>();
	let dropped = 0;
	for (const { path, after } of read) {
		if (!after) continue;
		for (const imported of after.imports) {
			if (imported.resolved === undefined) continue;
			const target = await existingTarget(readTree, head.treeHash, imported.resolved);
			if (!target) continue;
			const used = [
				...imported.names.map((name) => ({ name: name.imported, lines: name.uses })),
				...(imported.namespace?.uses ?? []),
			];
			for (const { name, lines } of used) {
				if (!lines.length) continue;
				const key = `${target}\0${name}`;
				let use = uses.get(key);
				if (!use) {
					if (uses.size >= USES_PER_FOOTPRINT) {
						dropped++;
						continue;
					}
					uses.set(key, (use = { file: target, name, at: [] }));
				}
				for (const line of lines) if (use.at.length < SITES_PER_NAME) use.at.push({ file: path, line });
			}
		}
	}
	if (dropped) console.log(`footprint: kept ${USES_PER_FOOTPRINT} names used, ${dropped} more dropped`);
	return { alters: altersOf(read), uses: [...uses.values()] };
}

/** The names a commit alters, against the tree of its first parent (null for a root commit). */
export async function commitAlters(
	source: HistorySource,
	commit: Pick<CommitMeta, "hash" | "treeHash">,
	parentTree: string | null,
	facts: FactsSource,
): Promise<Alter[]> {
	const files = await filesBetween(source, parentTree, commit.treeHash);
	return altersOf(await readFiles(source, treeReader(source), parentTree, commit.treeHash, files, facts));
}

/**
 * Who landed a commit: a GitHive merge's change, agent and intent from its trailers, or a plain commit's author. Only
 * a merge commit's trailers are taken (GitHive always lands a change as one): a plain commit that writes them could
 * otherwise drop another change's footprint and land in the feed under any agent's name.
 */
export function landingOf(commit: Pick<CommitMeta, "hash" | "message" | "author" | "parents">): Landing {
	const said = (name: string) => (commit.parents.length > 1 ? trailer(commit.message, name) : undefined);
	const cut = (text: string) => text.slice(0, LANDED_INTENT_CHARS);
	const change = said("GitHive-Change");
	if (change) {
		const intent = said("GitHive-Intent");
		return {
			by: said("GitHive-Agent") ?? commit.author.name,
			commit: commit.hash,
			change,
			...(intent ? { intent: cut(intent) } : {}),
		};
	}
	const subject = commit.message.split("\n")[0]?.trim();
	return { by: commit.author.name, commit: commit.hash, ...(subject ? { intent: cut(subject) } : {}) };
}

/**
 * Facts as kept and compared: a long signature becomes its start and a hash of the whole, so a big type alias doesn't
 * make its file's facts as big as the file. Applied the same way to every file, kept or fresh, so they still compare.
 */
export function keptFacts(facts: FileFacts): FileFacts {
	if (!facts.declarations.some((declaration) => compact(declaration.signature).length > SIGNATURE_KEPT)) return facts;
	return {
		...facts,
		declarations: facts.declarations.map((declaration) => {
			const whole = compact(declaration.signature);
			if (whole.length <= SIGNATURE_KEPT) return declaration;
			return { ...declaration, signature: `${declaration.signature.slice(0, SIGNATURE_SHOWN)}… #${hashOf(whole)}` };
		}),
	};
}

type ReadFile = { path: string; before: FileFacts | null; after: FileFacts | null };
type ReadTree = (hash: string) => Promise<TreeEntry[] | null>;

// The names each file alters, before against after. Two long signatures with the same hash are the same, however
// their kept starts were spaced.
function altersOf(read: ReadFile[]): Alter[] {
	const alters: Alter[] = [];
	for (const { path, before, after } of read)
		for (const altered of alteredNames(before, after)) {
			const hashes = [altered.before, altered.after].map((signature) => HASHED.exec(signature ?? "")?.[1]);
			if (altered.change === "interface" && hashes[0] && hashes[0] === hashes[1]) continue;
			alters.push({ file: path, altered });
		}
	if (alters.length > ALTERS_PER_FOOTPRINT)
		console.log(`footprint: kept ${ALTERS_PER_FOOTPRINT} of ${alters.length} altered names`);
	return alters.slice(0, ALTERS_PER_FOOTPRINT);
}

/**
 * The facts of each TS/JS file among `files` in two trees: NO_FILE where a tree hasn't the file, null where it has
 * one that couldn't be read or parsed. At most FILES_PER_PUSH files.
 */
async function readFiles(
	source: HistorySource,
	readTree: ReadTree,
	beforeTree: string | null,
	afterTree: string,
	files: string[],
	facts: FactsSource,
): Promise<ReadFile[]> {
	const code = files.filter((path) => languageOf(path));
	if (code.length > FILES_PER_PUSH)
		console.log(`footprint: read ${FILES_PER_PUSH} of ${code.length} changed TS/JS files, the rest skipped`);
	const paths = code.slice(0, FILES_PER_PUSH);
	const entries = await atMost(READS_AT_ONCE, paths, async (path) => ({
		path,
		before: beforeTree ? await fileAt(readTree, beforeTree, path) : null,
		after: await fileAt(readTree, afterTree, path),
	}));
	const wanted = entries.flatMap(({ path, before, after }) =>
		[before, after].flatMap((entry) => (entry && isFile(entry) ? [{ path, blob: entry.hash }] : [])),
	);
	const known = await factsOf(source, wanted, facts);
	const side = (path: string, entry: TreeEntry | null) => {
		if (!entry) return NO_FILE;
		return isFile(entry) ? (known.get(factsKey(entry.hash, path)) ?? null) : null;
	};
	return entries.map(({ path, before, after }) => ({
		path,
		before: side(path, before),
		after: side(path, after),
	}));
}

// Facts for each (blob, path): kept ones first, then each missing blob read and parsed while the batch's budget
// lasts, and kept. Absent from the result when it couldn't be read or parsed.
async function factsOf(source: HistorySource, wanted: { path: string; blob: string }[], facts: FactsSource) {
	const unique = [...new Map(wanted.map((each) => [factsKey(each.blob, each.path), each])).entries()];
	const known = new Map<string, FileFacts>(
		Object.entries(
			await facts.kept(unique.map(([key]) => key)).catch((err) => {
				console.error(`footprint: reading kept facts failed: ${String(err)}`);
				return {} as Record<string, FileFacts>;
			}),
		),
	);
	const readBlob = source.readBlob?.bind(source);
	let missing = unique.filter(([key]) => !known.has(key));
	if (!readBlob || !missing.length) return known;
	if (missing.length > facts.budget.parses) {
		console.log(`footprint: this batch's parses ran out; ${missing.length - facts.budget.parses} files skipped`);
		missing = missing.slice(0, Math.max(0, facts.budget.parses));
	}
	facts.budget.parses -= missing.length;
	const fresh: Record<string, FileFacts> = {};
	// Each blob is parsed as soon as it arrives, so only the few being read at once are held, never a batch's worth.
	await atMost(READS_AT_ONCE, missing, async ([key, { path, blob }]) => {
		const bytes = await readBlob(blob, MAX_PARSE_CHARS).catch(() => null);
		const parsed = bytes instanceof Uint8Array ? await parseWithin(path, bytes, facts.budget) : null;
		if (!parsed) return;
		known.set(key, parsed);
		fresh[key] = parsed;
	});
	if (Object.keys(fresh).length)
		await facts.keep(fresh).catch((err) => console.error(`footprint: keeping facts failed: ${String(err)}`));
	return known;
}

// A blob's facts as kept, while the batch's characters last. A file over the parse cap in bytes is skipped without
// decoding it (in characters it may be a little under, which costs only a hint).
async function parseWithin(path: string, bytes: Uint8Array, budget: FactsSource["budget"]) {
	if (bytes.byteLength > MAX_PARSE_CHARS) return null;
	const text = new TextDecoder().decode(bytes);
	if (text.length > budget.chars) {
		console.log(`footprint: this batch's characters ran out; ${path} skipped`);
		return null;
	}
	budget.chars -= text.length;
	const parsed = await fileFacts(path, text);
	return parsed ? keptFacts(parsed) : null;
}

// The file an import of `target` loads in the tree, if it's TS or JS: tried in TypeScript's order.
async function existingTarget(readTree: ReadTree, tree: string, target: string) {
	for (const candidate of importTargets(target)) {
		if (!languageOf(candidate)) continue;
		const entry = await fileAt(readTree, tree, candidate);
		if (entry && isFile(entry)) return candidate;
	}
	return null;
}

const isFile = (entry: TreeEntry) => entry.type === "blob" || entry.type === "exec";

// The entry at `path` in a tree, if it isn't a folder; null when anything on the way is missing or isn't a folder.
async function fileAt(readTree: ReadTree, tree: string, path: string): Promise<TreeEntry | null> {
	const segments = path.split("/");
	let entries = (await readTree(tree)) ?? [];
	for (const [index, name] of segments.entries()) {
		const entry = entries.find((each) => each.name === name);
		if (!entry) return null;
		if (index === segments.length - 1) return entry.type === "tree" ? null : entry;
		if (entry.type !== "tree") return null;
		entries = (await readTree(entry.hash)) ?? [];
	}
	return null;
}

// Each tree read at most once for one footprint.
function treeReader(source: HistorySource): ReadTree {
	const read = new Map<string, Promise<TreeEntry[] | null>>();
	return (hash) => {
		if (!read.has(hash)) read.set(hash, source.readTree(hash));
		return read.get(hash)!;
	};
}

// A 53-bit hash as 14 hex digits (cyrb53): enough to tell two long signatures apart, for a hint.
function hashOf(text: string) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export { hashOf as footprintHash };
