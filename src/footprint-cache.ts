import { DurableObject } from "cloudflare:workers";
import { Traffic, objectLabel } from "./cache-traffic";
import {
	type AlteredName,
	type FileFacts,
	headsUpNext,
	headsUpSays,
	headsUpUsedNext,
	headsUpUsedSays,
	importedName,
	interfaceNext,
	interfaceSays,
	type Landing,
	type OpenChange,
	type UseFact,
} from "./footprint";
import { type Alter, footprintHash, type UseOf } from "./footprint/footprints";
import type { HiveEvent } from "./hive-events";
import { projectBranch } from "./project-branch";
import type { AwarenessParts, FootprintStore } from "./push-events";
import type { Notice } from "./repo-cache";
import { rpc } from "./rpc";
import type { Registry } from "./toolkit/claims";
import { forkName, toolContextFor } from "./toolkit/env";
import { advice, claimsRef, recordLog } from "./toolkit/tools/repo";
import { cachingHistory } from "./toolkit/tree-reads";

// One per repo ("footprints:<repo>"): what awareness keeps (docs/awareness.md, "Footprints and interface news").
// Parsed files' facts by blob and path; each open change's footprint at its head (the names it alters and the names
// it uses); indexes from a file's name to the changes that alter or use it, so a lookup never loads every footprint;
// which notices were told; and the last commit analysed on each branch. The push-event consumer reads Git and parses;
// this compares and sends the notices into the repo's RepoCache, where agents' news is read. All of it is derived
// from Git, so losing it costs only missed hints. It has an object of its own so parsing state never shares
// RepoCache's memory.
//
// Keys (an index key's parts URI-encoded, so a ":" in a path or a name can't run into the next part; facts and told
// keys are only ever read whole):
//   facts:<blob>:<path>                         a file's facts           facts-at:<seq>:<blob>:<path>   their order
//   fp:<change>                                 an open footprint        fp-at:<seq>:<change>           their order
//   on:<branch>:<change>                        the footprints on a branch
//   uses:<branch>:<file>:<name>:<change>        where a change uses a name of a file ("*" for all of it)
//   alters:<branch>:<file>:<name>:<change>      what a change alters under a name of a file, as importers name it
//   told:<id>                                   a notice told           told-at:<seq>:<id>             their order
//   last:<branch>                               the last commit analysed there
//   seq, count:<kind>                           the order counter, and how many of each kind are kept

/** An open change's footprint, as the push consumer reads it. */
export interface Footprint {
	change: string;
	agent: string;
	intent?: string;
	/** The branch the change goes into. */
	branch: string;
	head: string;
	base: string;
	/** When it was pushed: an older push never replaces a newer one's footprint. */
	at: number;
	alters: Alter[];
	uses: UseOf[];
}

/** A commit that landed on a branch: who landed it, and the names it altered. */
export type LandedCommit = Landing & { alters: Alter[] };

/** A footprint as kept: what telling about it needs, and the keys that take it out again. */
interface KeptFootprint {
	change: string;
	agent: string;
	intent?: string;
	branch: string;
	head: string;
	base: string;
	at: number;
	/** Its key in the order footprints were kept. */
	order: string;
	/** Its index entries' keys. */
	keys: string[];
}

interface UsesEntry {
	at: UseOf["at"];
	when: number;
}

interface AltersEntry {
	altered: AlteredName[];
	when: number;
}

/** The most open footprints kept for a repo; the oldest are dropped. A soft cap: claims end long before. */
const OPEN_KEPT = 2_000;
/** The most changes kept as using one name of a file; the oldest pushes are dropped. */
const USERS_PER_NAME = 20;
/** The most heads-up notices one push sends, and the most interface notices one branch push sends. */
const HEADS_UPS_PER_PUSH = 50;
const INTERFACE_NOTICES_PER_PUSH = 200;
/** The most told markers kept, and parsed files' facts; the oldest are dropped. */
const TOLD_KEPT = 10_000;
const FACTS_KEPT = 5_000;
/** A file's facts bigger than this aren't kept: they're parsed again when needed. */
const FACTS_CHARS = 256 * 1024;
/** Keys longer than this aren't written (Durable Object storage takes keys up to 2 KiB). */
const KEY_CHARS = 1_024;
/** The most names a hive event's detail lists. */
const NAMES_SHOWN = 5;
/** Storage reads and writes at most this many keys at once. */
const STORAGE_BATCH = 128;

const enc = encodeURIComponent;
const pad = (seq: number) => String(seq).padStart(12, "0");
/** The change a uses: or alters: key ends with. */
const changeIn = (key: string) => decodeURIComponent(key.slice(key.lastIndexOf(":") + 1));

/** A repo's FootprintCache. */
export const footprintCache = (env: Env, repo: string) => env.FOOTPRINT_CACHE.getByName(`footprints:${repo}`);

/**
 * What the push consumer reads awareness through, in the Worker: Artifacts' API (trees and blobs kept for the isolate),
 * the claims as the advice tools read them, and each repo's FootprintCache. Null without a FootprintCache binding.
 */
export function awarenessParts(env: Env): AwarenessParts | null {
	if (!env.FOOTPRINT_CACHE || !env.ARTIFACTS) return null;
	const ctx = toolContextFor(env, undefined);
	return {
		history: cachingHistory(ctx.history!),
		claims: async (repo) => {
			const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
			if (!registry?.baseline) return null;
			const { claims } = await ctx.keptClaims!(repo, () => advice(ctx, repo));
			return { branch: projectBranch(registry), claims };
		},
		branchHead: (repo, branch) => ctx.branchHead!(repo, branch),
		forkOf: (repo, agent) => forkName(repo, agent),
		// The stub's methods return what the class's do, as RPC results.
		footprints: (repo) => footprintCache(env, repo) as unknown as FootprintStore,
	};
}

export class FootprintCache extends DurableObject<Env> {
	private readonly traffic = new Traffic(() => objectLabel(this.ctx));

	/** The facts kept for these `blob:path` keys. */
	async factsOf(keys: string[]) {
		const got = await this.getMany<FileFacts>(keys.map((key) => `facts:${key}`));
		const found: Record<string, FileFacts> = {};
		for (const [key, facts] of got) found[key.slice("facts:".length)] = facts;
		this.traffic.sent("facts", JSON.stringify(found).length);
		return found;
	}

	/** Keeps files' facts by `blob:path`. A blob never changes, so they never go stale; the oldest go past the cap. */
	async keepFacts(facts: Record<string, FileFacts>) {
		const entries = Object.entries(facts).filter(([key, value]) => {
			const size = JSON.stringify(value).length;
			this.traffic.kept("facts", size);
			return size <= FACTS_CHARS && key.length <= KEY_CHARS;
		});
		await this.keepCapped("facts", entries, FACTS_KEPT);
	}

	/** The head a change's footprint was read at, and when it was pushed, if one is kept. */
	async keptHead(change: string) {
		const kept = await this.kept(change);
		return kept ? { head: kept.head, at: kept.at } : null;
	}

	/** Whether any open footprint goes into `branch`, and the last commit analysed there. */
	async branchState(branch: string) {
		const on = await this.ctx.storage.list({ prefix: `on:${enc(branch)}:`, limit: 1 });
		return { open: on.size > 0, last: (await this.ctx.storage.get<string>(`last:${enc(branch)}`)) ?? null };
	}

	/** Notes the last commit analysed on `branch`, for a push event that doesn't say where the branch was. */
	async analysed(branch: string, commit: string) {
		await this.ctx.storage.put(`last:${enc(branch)}`, commit);
	}

	/**
	 * Keeps a change's footprint, replacing an older push's, and tells the heads-ups it raises with the other open
	 * changes into the same branch: when one alters a name the other uses, both agents hear it, once per
	 * alteration: a later push that keeps the same signature tells nothing new. `claimed` maps each change claimed now to its agent; another change found unclaimed is dropped.
	 * Returns how many notices it sent.
	 */
	async keep(repo: string, footprint: Footprint, claimed: Record<string, string>) {
		const kept = await this.kept(footprint.change);
		if (kept && kept.at > footprint.at) return 0;
		if (kept) await this.unindex(kept);
		await this.index(footprint);
		if (!kept) await this.countOpen(1);
		return this.headsUps(repo, footprint, claimed);
	}

	/** Drops these changes' footprints: their branch was deleted, or they landed. */
	async drop(changes: string[]) {
		for (const change of changes) await this.dropChange(change);
	}

	/**
	 * The commits that landed on `branch`, oldest first, up to `after`. Each landed change's footprint goes, and every
	 * other open change into the branch that uses a name a commit altered hears an `interface` notice, once per commit
	 * and change, with one hive event per commit. Returns how many notices it sent.
	 */
	async landed(repo: string, branch: string, commits: LandedCommit[], claimed: Record<string, string>, after: string) {
		const notices: { agent: string; notice: Notice }[] = [];
		const events: HiveEvent[] = [];
		const told: string[] = [];
		const at = new Date().toISOString();
		let dropped = 0;
		for (const [index, commit] of commits.entries()) {
			if (commit.change) await this.dropChange(commit.change);
			const facts = await this.usersOf(branch, commit.alters, commit.change);
			if (!facts.size) continue;
			const footprints = await this.keptMany([...facts.keys()]);
			// A change whose base is this commit or a later one in the push already has it.
			const later = new Set(commits.slice(index).map((each) => each.commit));
			const recipients: { kept: KeptFootprint; facts: UseFact[]; id: string }[] = [];
			for (const [change, each] of facts) {
				const kept = footprints.get(change);
				if (!kept || later.has(kept.base)) continue;
				if (claimed[change] !== kept.agent) {
					await this.dropChange(change);
					continue;
				}
				recipients.push({ kept, facts: each, id: footprintHash(`interface\0${commit.commit}\0${change}`) });
			}
			const already = await this.toldOf(recipients.map((each) => each.id));
			const fresh = recipients.filter((each) => !already.has(each.id));
			const room = Math.max(0, INTERFACE_NOTICES_PER_PUSH - notices.length);
			dropped += Math.max(0, fresh.length - room);
			const sent = fresh.slice(0, room);
			for (const { kept, facts: said } of sent)
				notices.push({
					agent: kept.agent,
					notice: {
						kind: "interface",
						at,
						says: interfaceSays(commit, said),
						next: interfaceNext(branch),
						change: kept.change,
						from: { agent: commit.by, ...(commit.change ? { change: commit.change } : {}) },
						detail: { commit: commit.commit, names: namesOf(said) },
					},
				});
			told.push(...sent.map((each) => each.id));
			const first = sent[0];
			if (first)
				events.push({
					kind: "interface",
					agent: commit.by,
					change: first.kept.change,
					other: first.kept.agent,
					commit: commit.commit,
					detail: namesLine(sent.flatMap((each) => each.facts)),
					at,
				});
		}
		if (dropped) console.log(`footprints: ${dropped} interface notices on ${branch} over the cap were dropped`);
		await this.analysed(branch, after);
		return this.tell(repo, branch, notices, events, told);
	}

	/** Forget everything kept, for a deleted repo. */
	async forget() {
		await this.ctx.storage.deleteAll();
	}

	// The heads-ups a footprint raises: what it alters that other open changes into its branch use, and what it uses
	// that they alter. One notice to each side of a pair, and one hive event a pair.
	private async headsUps(repo: string, footprint: Footprint, claimed: Record<string, string>) {
		const pairs = new Map<string, { alterer: string; user: string; facts: UseFact[] }>();
		const add = (alterer: string, user: string, fact: UseFact) => {
			const key = `${alterer}\0${user}`;
			const pair = pairs.get(key) ?? { alterer, user, facts: [] };
			pair.facts.push(fact);
			pairs.set(key, pair);
		};
		for (const [other, facts] of await this.usersOf(footprint.branch, footprint.alters, footprint.change))
			for (const fact of facts) add(footprint.change, other, fact);
		const branch = enc(footprint.branch);
		for (const use of footprint.uses) {
			const name = use.name === "*" ? "" : `${enc(use.name)}:`;
			const altering = await this.ctx.storage.list<AltersEntry>({
				prefix: `alters:${branch}:${enc(use.file)}:${name}`,
			});
			for (const [key, entry] of altering) {
				const other = changeIn(key);
				if (other === footprint.change) continue;
				for (const altered of entry.altered)
					add(other, footprint.change, { file: use.file, altered, imported: use.name, at: use.at });
			}
		}
		if (!pairs.size) return 0;
		const others = await this.keptMany(
			[...pairs.values()].map((pair) => (pair.alterer === footprint.change ? pair.user : pair.alterer)),
		);
		const self = { ...footprint, order: "", keys: [] } satisfies KeptFootprint;
		const open = new Map<string, KeptFootprint>([[footprint.change, self]]);
		for (const [change, kept] of others) {
			if (claimed[change] === kept.agent) open.set(change, kept);
			else await this.dropChange(change);
		}
		type Told = { alterer: KeptFootprint; user: KeptFootprint; facts: UseFact[]; ids: string[] };
		const candidates: Told[] = [];
		for (const { alterer, user, facts } of pairs.values()) {
			const [a, u] = [open.get(alterer), open.get(user)];
			// An agent knows its own changes.
			if (!a || !u || a.agent === u.agent) continue;
			// Told once per alteration, not per push: a new push that keeps the same signature tells nothing new, and a
			// different signature is told again.
			const ids = facts.map((fact) =>
				footprintHash(
					`heads_up\0${a.change}\0${u.change}\0${fact.file}\0${fact.altered.name}\0${fact.imported}\0` +
						`${fact.altered.change}\0${fact.altered.after ?? ""}`,
				),
			);
			candidates.push({ alterer: a, user: u, facts, ids });
		}
		const already = await this.toldOf(candidates.flatMap((each) => each.ids));
		const notices: { agent: string; notice: Notice }[] = [];
		const events: HiveEvent[] = [];
		const told: string[] = [];
		const at = new Date().toISOString();
		let dropped = 0;
		for (const { alterer, user, facts, ids } of candidates) {
			const fresh = facts.filter((_, index) => !already.has(ids[index]!));
			if (!fresh.length) continue;
			if (notices.length + 2 > HEADS_UPS_PER_PUSH) {
				dropped++;
				continue;
			}
			const names = namesOf(fresh);
			const [them, us] = [openChange(alterer), openChange(user)];
			notices.push(
				{
					agent: user.agent,
					notice: {
						kind: "heads_up",
						at,
						says: headsUpSays(them, fresh),
						next: headsUpNext(them),
						change: user.change,
						from: { agent: alterer.agent, change: alterer.change },
						detail: { names },
					},
				},
				{
					agent: alterer.agent,
					notice: {
						kind: "heads_up",
						at,
						says: headsUpUsedSays(us, fresh),
						next: headsUpUsedNext(us),
						change: alterer.change,
						from: { agent: user.agent, change: user.change },
						detail: { names },
					},
				},
			);
			events.push({
				kind: "heads_up",
				agent: alterer.agent,
				change: alterer.change,
				other: user.agent,
				detail: namesLine(fresh),
				at,
			});
			told.push(...ids.filter((id) => !already.has(id)));
		}
		if (dropped) console.log(`footprints: ${dropped} heads-ups for ${footprint.change} over the cap were dropped`);
		return this.tell(repo, footprint.branch, notices, events, told);
	}

	// The open changes into `branch` that use what `alters` alter, but `except`, with what each uses: by the name it's
	// imported as, or through the whole file.
	private async usersOf(branch: string, alters: Alter[], except?: string) {
		const users = new Map<string, UseFact[]>();
		for (const [file, name, altered] of byImportedName(alters))
			for (const as of [name, "*"]) {
				const using = await this.ctx.storage.list<UsesEntry>({
					prefix: `uses:${enc(branch)}:${enc(file)}:${enc(as)}:`,
				});
				for (const [key, entry] of using) {
					const change = changeIn(key);
					if (change === except) continue;
					const facts = users.get(change) ?? [];
					for (const each of altered) facts.push({ file, altered: each, imported: as, at: entry.at });
					users.set(change, facts);
				}
			}
		return users;
	}

	// Sends notices and hive events into the repo's RepoCache in one call, and only then marks them told.
	private async tell(
		repo: string,
		branch: string,
		notices: { agent: string; notice: Notice }[],
		events: HiveEvent[],
		told: string[],
	) {
		if (!notices.length) return 0;
		try {
			await rpc(this.env.REPO_CACHE.getByName(`repo:${repo}`).notify(branch, notices, events));
		} catch (err) {
			console.error(`footprints: telling ${notices.length} notices on ${repo}'s ${branch} failed: ${String(err)}`);
			return 0;
		}
		await this.keepCapped(
			"told",
			told.map((id) => [id, 1]),
			TOLD_KEPT,
		);
		return notices.length;
	}

	private async index(footprint: Footprint) {
		const branch = enc(footprint.branch);
		const change = enc(footprint.change);
		const when = footprint.at;
		const entries: [string, unknown][] = [[`on:${branch}:${change}`, 1]];
		for (const [file, name, altered] of byImportedName(footprint.alters))
			entries.push([`alters:${branch}:${enc(file)}:${enc(name)}:${change}`, { altered, when } satisfies AltersEntry]);
		for (const use of footprint.uses) {
			const prefix = `uses:${branch}:${enc(use.file)}:${enc(use.name)}:`;
			await this.makeRoom(prefix, footprint.change);
			entries.push([`${prefix}${change}`, { at: use.at, when } satisfies UsesEntry]);
		}
		const indexed = entries.filter(([key]) => key.length <= KEY_CHARS);
		const order = `fp-at:${pad(await this.nextSeq(1))}:${change}`;
		const kept: KeptFootprint = {
			change: footprint.change,
			agent: footprint.agent,
			...(footprint.intent ? { intent: footprint.intent } : {}),
			branch: footprint.branch,
			head: footprint.head,
			base: footprint.base,
			at: footprint.at,
			order,
			keys: indexed.map(([key]) => key),
		};
		await this.putMany([...indexed, [order, 1], [`fp:${change}`, kept]]);
	}

	// Room for one more change using a name: past USERS_PER_NAME, the oldest pushes' uses are dropped from the index.
	private async makeRoom(prefix: string, change: string) {
		const using = [...(await this.ctx.storage.list<UsesEntry>({ prefix }))].filter(([key]) => changeIn(key) !== change);
		if (using.length < USERS_PER_NAME) return;
		const oldest = using.sort((a, b) => a[1].when - b[1].when).slice(0, using.length - USERS_PER_NAME + 1);
		await this.deleteMany(oldest.map(([key]) => key));
		console.log(`footprints: ${oldest.length} uses of ${prefix} dropped, past ${USERS_PER_NAME} changes`);
	}

	private async unindex(kept: KeptFootprint) {
		await this.deleteMany([...kept.keys, kept.order, `fp:${enc(kept.change)}`]);
	}

	private async dropChange(change: string) {
		const kept = await this.kept(change);
		if (!kept) return;
		await this.unindex(kept);
		await this.countOpen(-1);
	}

	// Counts open footprints, and drops the oldest past OPEN_KEPT.
	private async countOpen(added: number) {
		let count = Math.max(0, ((await this.ctx.storage.get<number>("count:fp")) ?? 0) + added);
		if (count > OPEN_KEPT) {
			const oldest = await this.ctx.storage.list({ prefix: "fp-at:", limit: count - OPEN_KEPT });
			const changes = [...oldest.keys()].map((key) => decodeURIComponent(key.slice("fp-at:".length + 13)));
			for (const [, kept] of await this.keptMany(changes)) await this.unindex(kept);
			// An order key left behind by a lost write goes too.
			await this.deleteMany([...oldest.keys()]);
			count -= oldest.size;
			console.log(`footprints: dropped the ${oldest.size} oldest open footprints, past ${OPEN_KEPT}`);
		}
		await this.ctx.storage.put("count:fp", count);
	}

	private async kept(change: string) {
		return (await this.ctx.storage.get<KeptFootprint>(`fp:${enc(change)}`)) ?? null;
	}

	private async keptMany(changes: string[]) {
		const got = await this.getMany<KeptFootprint>([...new Set(changes)].map((change) => `fp:${enc(change)}`));
		return new Map([...got.values()].map((kept) => [kept.change, kept]));
	}

	private async toldOf(ids: string[]) {
		const got = await this.getMany<number>([...new Set(ids)].map((id) => `told:${id}`));
		return new Set([...got.keys()].map((key) => key.slice("told:".length)));
	}

	// Keeps entries under `<kind>:<id>`, notes new ones' order under `<kind>-at:<seq>:<id>`, and drops the oldest past
	// `cap`, reading only the order keys it drops.
	private async keepCapped(kind: string, entries: [string, unknown][], cap: number) {
		if (!entries.length) return;
		const had = await this.getMany(entries.map(([id]) => `${kind}:${id}`));
		const added = [...new Set(entries.map(([id]) => id).filter((id) => !had.has(`${kind}:${id}`)))];
		let seq = await this.nextSeq(added.length);
		await this.putMany([
			...entries.map(([id, value]): [string, unknown] => [`${kind}:${id}`, value]),
			...added.map((id): [string, unknown] => [`${kind}-at:${pad(seq++)}:${id}`, 1]),
		]);
		let count = ((await this.ctx.storage.get<number>(`count:${kind}`)) ?? 0) + added.length;
		if (count > cap) {
			const at = `${kind}-at:`;
			const oldest = [...(await this.ctx.storage.list({ prefix: at, limit: count - cap })).keys()];
			await this.deleteMany(oldest.flatMap((key) => [key, `${kind}:${key.slice(at.length + 13)}`]));
			count -= oldest.length;
			console.log(`footprints: dropped the ${oldest.length} oldest ${kind}, past ${cap}`);
		}
		await this.ctx.storage.put(`count:${kind}`, count);
	}

	// The next `count` numbers in the order things are kept.
	private async nextSeq(count: number) {
		const next = (await this.ctx.storage.get<number>("seq")) ?? 0;
		await this.ctx.storage.put("seq", next + count);
		return next;
	}

	private async getMany<T>(keys: string[]) {
		const found = new Map<string, T>();
		for (let i = 0; i < keys.length; i += STORAGE_BATCH)
			for (const [key, value] of await this.ctx.storage.get<T>(keys.slice(i, i + STORAGE_BATCH))) found.set(key, value);
		return found;
	}

	private async putMany(entries: [string, unknown][]) {
		for (let i = 0; i < entries.length; i += STORAGE_BATCH)
			await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH)));
	}

	private async deleteMany(keys: string[]) {
		for (let i = 0; i < keys.length; i += STORAGE_BATCH)
			await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
	}
}

// A change's alterations grouped by file and the name importers know them by: a class's members go under the class,
// a default export under "default".
function byImportedName(alters: Alter[]): [string, string, AlteredName[]][] {
	const groups = new Map<string, [string, string, AlteredName[]]>();
	for (const { file, altered } of alters) {
		const name = importedName(altered);
		const key = `${file}\0${name}`;
		const group = groups.get(key) ?? [file, name, []];
		group[2].push(altered);
		groups.set(key, group);
	}
	return [...groups.values()];
}

const openChange = (kept: KeptFootprint): OpenChange => ({
	by: kept.agent,
	change: kept.change,
	...(kept.intent ? { intent: kept.intent } : {}),
});

const namesOf = (facts: UseFact[]) => [...new Set(facts.map((fact) => fact.altered.name))];

/** "a, b, c, d, e and 2 more": the names for a hive event's detail. */
function namesLine(facts: UseFact[]) {
	const names = namesOf(facts);
	const more = names.length - NAMES_SHOWN;
	return names.slice(0, NAMES_SHOWN).join(", ") + (more > 0 ? ` and ${more} more` : "");
}
