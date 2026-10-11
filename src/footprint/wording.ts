import { importedName, type AlteredName } from "./compare";

// The `says` and `next` lines of interface and heads_up notices. Ported from artifact-submission's
// src/core/footprints.ts, from intents to changes. Lines stay bounded: long signatures and use lists are cut.

/** An altered name and where the told agent's change, or the other change, uses it. */
export type UseFact = {
	/** The file that declares the altered name. */
	file: string;
	altered: AlteredName;
	/** The name as it is imported there: the altered name, its class, "default", or "*" for a whole namespace. */
	imported: string;
	at: { file: string; line: number }[];
};

/** Who landed the commit: a GitHive change with its intent, or for plain git the commit's author and subject. */
export type Landing = { by: string; commit: string; change?: string; intent?: string };
/** Another open change. */
export type OpenChange = { by: string; change: string; intent?: string };

const MAX_SIGNATURE = 200;
const MAX_SITES = 5;

const code = (text: string) => `\`${text.length > MAX_SIGNATURE ? `${text.slice(0, MAX_SIGNATURE - 1)}…` : text}\``;

/** "`src/jobs/sync.ts:4`, `src/jobs/sync.ts:9`", at most MAX_SITES and then how many more. */
function sites(at: UseFact["at"]) {
	const shown = at.slice(0, MAX_SITES).map((a) => `\`${a.file}:${a.line}\``);
	if (at.length > MAX_SITES) shown.push(`${at.length - MAX_SITES} more`);
	return shown.join(", ");
}

/** "imports `x` from `f` and uses it at …", for each way a name is imported. */
function importsClause(f: UseFact) {
	const what =
		f.imported === "*"
			? `all of \`${f.file}\``
			: f.imported === "default"
				? `the default export of \`${f.file}\``
				: `\`${f.imported}\` from \`${f.file}\``;
	return `imports ${what} and uses it at ${sites(f.at)}`;
}

/** The subject a clause talks about: the imported name itself is "it", anything else is named. */
const isItself = (f: UseFact) => f.imported !== "*" && f.imported === f.altered.name;

/** For landed changes: "its interface changed from `a` to `b`", "it was removed (`a`)", "it is no longer exported"… */
export function whatChanged(f: UseFact): string {
	const a = f.altered;
	const it = isItself(f) ? "it" : code(a.name);
	if (a.change === "removed") return `${it} was removed (${code(a.before ?? "")})`;
	if (a.change === "no longer exported") return `${it} is no longer exported`;
	if (a.change === "now exported") return `${it} is now exported`;
	return `${isItself(f) ? "its interface" : code(a.name)} changed from ${code(a.before ?? "")} to ${code(a.after ?? "")}`;
}

/** For open changes, after a subject: "alters its interface from `a` to `b`", "removes it (`a`)", "stops exporting it"… */
function whatItDoes(f: UseFact): string {
	const a = f.altered;
	const it = isItself(f) ? "it" : code(a.name);
	if (a.change === "removed") return `removes ${it} (${code(a.before ?? "")})`;
	if (a.change === "no longer exported") return `stops exporting ${it}`;
	if (a.change === "now exported") return `exports ${it}`;
	return `alters ${isItself(f) ? "its interface" : code(a.name)} from ${code(a.before ?? "")} to ${code(a.after ?? "")}`;
}

/** One clause of an interface notice: "your change imports `x` from `f` and uses it at `g:4`; its interface changed…". */
export const useSays = (f: UseFact) => `your change ${importsClause(f)}; ${whatChanged(f)}`;

function landed(l: Landing) {
	const what = l.change ? `landed ${l.change}` : `pushed ${l.commit.slice(0, 7)}`;
	return `${l.by} ${what}${l.intent ? ` ("${l.intent}")` : ""}`;
}

/** An `interface` notice: a landed commit altered names the told agent's change uses. */
export function interfaceSays(landing: Landing, facts: UseFact[]): string {
	return `${landed(landing)}: ${facts.map(useSays).join("; ")}`;
}

/** The `next` of an interface notice. */
export function interfaceNext(branch: string): string {
	return `Merge the branch into yours and update those uses before you merge: git fetch origin ${branch} && git merge origin/${branch}.`;
}

const changeName = (o: OpenChange) => `${o.by}'s change ${o.change}${o.intent ? ` ("${o.intent}")` : ""}`;

/** A `heads_up` to the user: another open change alters names the told agent's change uses. */
export function headsUpSays(other: OpenChange, facts: UseFact[]): string {
	const clauses = facts.map((f) => `your change ${importsClause(f)}; their change ${whatItDoes(f)}`);
	return `${changeName(other)} alters code your change uses, not landed yet: ${clauses.join("; ")}`;
}

/** The `next` of a heads_up to the user. */
export function headsUpNext(other: OpenChange): string {
	return `Nothing has landed yet: agree on it with a note on ${other.change}, or update those uses once it lands.`;
}

/** A `heads_up` to the alterer: another open change uses names the told agent's change alters. */
export function headsUpUsedSays(other: OpenChange, facts: UseFact[]): string {
	const clauses = facts.map((f) => `their change ${importsClause(f)}; your change ${whatItDoes(f)}`);
	return `${changeName(other)} uses code your change alters: ${clauses.join("; ")}`;
}

/** The `next` of a heads_up to the alterer. */
export function headsUpUsedNext(other: OpenChange): string {
	return `Nothing has landed yet: agree on it with a note on ${other.change}, or keep what they use working.`;
}

/** A UseFact from an altered name and the uses (usesOf) one file of the change makes of it. */
export function useFact(file: string, altered: AlteredName, uses: { name: string; lines: number[] }[], inFile: string) {
	const fact: UseFact = { file, altered, imported: importedName(altered), at: [] };
	for (const u of uses) {
		if (u.name === "*") fact.imported = "*";
		for (const l of u.lines) fact.at.push({ file: inFile, line: l });
	}
	fact.at.sort((a, b) => a.line - b.line);
	return fact;
}
