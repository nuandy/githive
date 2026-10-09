import git from "isomorphic-git";
import { gitAuth, http } from "./git-http";
import { MemoryFS } from "./memory-fs";
import { retryTransient } from "./retry";

// The Artifacts binding manages repos but cannot write inside them, so every
// commit, merge and push goes through isomorphic-git over an in-memory tree.

const DIR = "/repo";

export const BOT = { name: "GitHive", email: "bot@githive.invalid" };

export interface Remote {
	url: string;
	token: string;
}

// Artifacts tokens look like art_v1_<secret>?expires=<unix>; Git auth wants only the secret.

/** Whether a ref listing failed only because the repo is empty (no HEAD yet): it then has no refs. */
export const isEmptyRepo = (err: unknown) => (err as { code?: string })?.code === "NotFoundError" && /HEAD/.test(String((err as Error)?.message));

/**
 * The repo's default branch: where its HEAD points (one request), or null for
 * an empty repo. A project's branch is whatever this is (main, master, ...).
 */
export async function defaultBranch(remote: Remote): Promise<string | null> {
	const refs = await retryTransient(() => git.listServerRefs({ http, url: remote.url, prefix: "HEAD", symrefs: true, ...gitAuth(remote) })).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
	const target = refs.find((r) => r.ref === "HEAD")?.target;
	return target?.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : null;
}

/** A branch's head on a remote, without cloning (one ls-remote), or null when it doesn't exist. */
export async function branchHead(remote: Remote, branch: string): Promise<string | null> {
	const refs = await retryTransient(() => git.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix: `refs/heads/${branch}`, ...gitAuth(remote) }));
	return refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null;
}

export type MergeOutcome = { clean: true } | { clean: false; files: string[] };
export interface ChangedFileText {
	path: string;
	before: string | null;
	after: string | null;
}

/** Commits of history a workspace starts with; it fetches more only when Git needs older commits. */
export const SHALLOW_DEPTH = 64;
/** Past this depth a deepening fetch is asking for all of history anyway. */
const FULL_DEPTH = 1 << 20;

/**
 * How many calls in this isolate work in a workspace at once: each holds its
 * copy of the project and what it fetched, about 3.5 MB of Express's (0 to 9
 * MB), until it ends. An isolate has 128 MB for all its requests, and at 200
 * agents enough merges and checks at once in one went past it ("Worker
 * exceeded memory limit"), failing every request in it. The rest wait their turn.
 */
const WORKSPACES_AT_ONCE = 6;
let inWorkspaces = 0;
const waitingForWorkspace: (() => void)[] = [];

/** Do `work`, which uses a workspace, in turn: at most WORKSPACES_AT_ONCE at once in this isolate. */
export async function inWorkspaceTurn<T>(work: () => Promise<T>): Promise<T> {
	if (inWorkspaces >= WORKSPACES_AT_ONCE) await new Promise<void>((resolve) => waitingForWorkspace.push(resolve));
	else inWorkspaces++;
	try {
		return await work();
	} finally {
		// The turn goes straight to the next waiting, if any; else it's free.
		const next = waitingForWorkspace.shift();
		if (next) next();
		else inWorkspaces--;
	}
}

/** Workspaces kept for the isolate by `Workspace.at`, by origin and branch, the most recently used last. */
const kept = new Map<string, { head: string; ws: Workspace }>();
const KEPT_WORKSPACES = 4;

/**
 * A repo in memory. It starts shallow, the last SHALLOW_DEPTH commits of each
 * branch it fetches, since a whole project's history may not fit (a Durable
 * Object has 128 MB). When an operation needs an older commit (the merge base
 * of a change that branched long ago, say), every branch fetched is deepened,
 * four times deeper each round, until Git has it.
 */
export class Workspace {
	/** What has been fetched, to deepen: remote name, URL and credentials, and branch. */
	private readonly sources: { remote: string; origin: Remote; ref: string }[] = [];
	/**
	 * isomorphic-git's cache for this repo's reads: without one, every read
	 * loads the packfile again (reading 200 merges took 22 s, and reads at once
	 * held a copy each).
	 */
	private readonly cache = {};

	private constructor(
		readonly fs: MemoryFS,
		readonly origin: Remote,
		/** The branch cloned (the project's branch, say main or master): head, merge and push default to it. */
		readonly branch: string,
		private depth: number,
	) {}

	/** Start an empty repo whose origin is a freshly created Artifacts repo. */
	static async init(origin: Remote, branch = "main") {
		const fs = new MemoryFS();
		await git.init({ fs, dir: DIR, defaultBranch: branch });
		return new Workspace(fs, origin, branch, FULL_DEPTH);
	}

	static async clone(origin: Remote, branch: string, { depth = SHALLOW_DEPTH }: { depth?: number } = {}) {
		return retryTransient(async () => {
			// A failed clone may have populated part of the object database, refs, or
			// worktree. Each attempt must therefore begin with an entirely fresh FS.
			const fs = new MemoryFS();
			await git.clone({ fs, http, dir: DIR, url: origin.url, ref: branch, singleBranch: true, depth, ...gitAuth(origin) });
			const ws = new Workspace(fs, origin, branch, depth);
			ws.sources.push({ remote: "origin", origin, ref: branch });
			return ws;
		});
	}

	/**
	 * A workspace with `branch` at `head`, for reading (a check, say): copied
	 * from one kept for the isolate when the branch hasn't moved, brought up
	 * to date with one fetch when it has, cloned only the first time. Each
	 * caller gets its own copy, so what one fetches the others never see. The
	 * branch may have moved again since `head` was read: it is then wherever
	 * the fetch found it.
	 */
	static async at(origin: Remote, branch: string, head: string) {
		const key = `${origin.url}|${branch}`;
		const hit = kept.get(key);
		if (hit?.head === head) return hit.ws.copy(origin);
		let ws: Workspace;
		if (hit) {
			ws = hit.ws.copy(origin);
			const result = await retryTransient(() => git.fetch({ fs: ws.fs, http, dir: DIR, remote: "origin", ref: branch, singleBranch: true, depth: ws.depth, ...gitAuth(origin) }));
			if (!result.fetchHead) throw new Error(`fetch of origin/${branch} returned no head`);
			// The worktree stays where it was: reading needs the branch, not the files.
			await git.writeRef({ fs: ws.fs, dir: DIR, ref: `refs/heads/${branch}`, value: result.fetchHead, force: true });
		} else ws = await Workspace.clone(origin, branch);
		kept.delete(key);
		kept.set(key, { head: await ws.head(), ws });
		while (kept.size > KEPT_WORKSPACES) kept.delete(kept.keys().next().value!);
		return ws.copy(origin);
	}

	/** An independent copy, fetching and deepening with `origin`'s credentials. */
	private copy(origin: Remote) {
		const copy = new Workspace(this.fs.copy(), origin, this.branch, this.depth);
		copy.sources.push(...this.sources.map((s) => (s.remote === "origin" ? { ...s, origin } : s)));
		return copy;
	}

	/** Fetch every branch fetched so far four times deeper. Returns false once history is whole. */
	private async deepen() {
		if (this.depth >= FULL_DEPTH) return false;
		this.depth = Math.min(this.depth * 4, FULL_DEPTH);
		for (const source of this.sources)
			await retryTransient(() => git.fetch({ fs: this.fs, http, dir: DIR, remote: source.remote, ref: source.ref, singleBranch: true, depth: this.depth, ...gitAuth(source.origin) }));
		return true;
	}

	/** Make sure a commit is here, deepening history until it is. */
	async ensureCommit(oid: string) {
		for (;;) {
			try {
				return await git.readCommit({ fs: this.fs, dir: DIR, oid, cache: this.cache });
			} catch (err) {
				if (!(err instanceof git.Errors.NotFoundError) || !(await this.deepen())) throw err;
			}
		}
	}

	async write(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			await this.fs.promises.writeFile(`${DIR}/${path}`, content);
			await git.add({ fs: this.fs, dir: DIR, filepath: path });
		}
	}

	commit(message: string, author = BOT) {
		return git.commit({ fs: this.fs, dir: DIR, message, author });
	}

	/** Make branch `name` at this workspace's branch head, and push it (one ref, no new objects). */
	async pushNewBranch(name: string) {
		await git.branch({ fs: this.fs, dir: DIR, ref: name, object: await this.head() });
		await this.push(name);
	}

	/** Push local ref `from` (a branch fetched, say) to `to` on `remote`, replacing what's there. */
	pushAs(from: string, to: string, remote: Remote) {
		return retryTransient(() => git.push({ fs: this.fs, http, dir: DIR, url: remote.url, ref: from, remoteRef: to, force: true, ...gitAuth(remote) }));
	}

	push(ref = this.branch, remote: Remote = this.origin) {
		return retryTransient(() => git.push({ fs: this.fs, http, dir: DIR, url: remote.url, ref, ...gitAuth(remote) }));
	}

	/** Fetch `ref` from another repo into refs/remotes/<name>/<ref>; returns its commit. */
	async fetch(name: string, remote: Remote, ref = this.branch) {
		await git.addRemote({ fs: this.fs, dir: DIR, remote: name, url: remote.url, force: true });
		const result = await retryTransient(() => git.fetch({
			fs: this.fs,
			http,
			dir: DIR,
			remote: name,
			ref,
			singleBranch: true,
			depth: this.depth,
			...gitAuth(remote),
		}));
		if (!result.fetchHead) throw new Error(`fetch of ${name}/${ref} returned no head`);
		this.sources.push({ remote: name, origin: remote, ref });
		return result.fetchHead;
	}

	head(ref = this.branch) {
		return git.resolveRef({ fs: this.fs, dir: DIR, ref });
	}

	/** The best common ancestor of two commits, deepening history until it shows. */
	async mergeBase(a: string, b: string) {
		for (;;) {
			const [oid] = await git.findMergeBase({ fs: this.fs, dir: DIR, oids: [await this.oid(a), await this.oid(b)], cache: this.cache }).catch((err) => {
				if (err instanceof git.Errors.NotFoundError) return [];
				throw err;
			});
			if (oid) return oid as string;
			if (!(await this.deepen())) throw new Error(`no common ancestor for ${a} and ${b}`);
		}
	}

	private async oid(ref: string) {
		return /^[0-9a-f]{40}$/.test(ref) ? ref : git.resolveRef({ fs: this.fs, dir: DIR, ref });
	}

	/** Test-merge two refs without touching any branch. */
	async tryMerge(ours: string, theirs: string): Promise<MergeOutcome> {
		// A merge needs the commits' common ancestor here.
		await this.mergeBase(ours, theirs);
		try {
			await git.merge({ fs: this.fs, dir: DIR, ours, theirs, dryRun: true, abortOnConflict: true, author: BOT, cache: this.cache });
			return { clean: true };
		} catch (err) {
			if (err instanceof git.Errors.MergeConflictError) return { clean: false, files: err.data.filepaths };
			throw err;
		}
	}

	/** Merge `theirs` into the local branch. Throws MergeConflictError on conflict. */
	async merge(theirs: string, message: string) {
		await this.mergeBase(this.branch, theirs);
		return git.merge({ fs: this.fs, dir: DIR, ours: this.branch, theirs, message, author: BOT, abortOnConflict: true, cache: this.cache });
	}

	/** Paths whose content differs between two commits. */
	async changedPaths(from: string, to: string) {
		// One after the other: each may deepen history.
		await this.ensureCommit(await this.oid(from));
		await this.ensureCommit(await this.oid(to));
		const changed: string[] = [];
		await git.walk({
			fs: this.fs,
			dir: DIR,
			cache: this.cache,
			trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
			map: async (path, [a, b]) => {
				if (path === ".") return true;
				const [typeA, typeB] = [await a?.type(), await b?.type()];
				// A tree/blob collision is both a changed file and a directory to
				// descend into, so keep the blob path and still visit descendants.
				if (typeA === "tree" || typeB === "tree") {
					if ((typeA === "blob" || typeB === "blob") && typeA !== typeB) changed.push(path);
					// The same folder on both sides holds the same files: nothing in it changed, so it isn't walked.
					else if (typeA === typeB && (await a?.oid()) === (await b?.oid())) return null;
					return true;
				}
				if ((await a?.oid()) !== (await b?.oid())) changed.push(path);
				return true;
			},
		});
		return changed;
	}

	/** Obtain UTF-8 old/new text for every changed file between two commits. */
	async changedFiles(from: string, to: string): Promise<ChangedFileText[]> {
		// One after the other: each may deepen history.
		await this.ensureCommit(await this.oid(from));
		await this.ensureCommit(await this.oid(to));
		const changed: ChangedFileText[] = [];
		const textAt = async (entry: { oid(): Promise<string | null> } | null | undefined, type: string | undefined) => {
			if (!entry || type !== "blob") return null;
			const oid = await entry.oid();
			if (!oid) return null;
			const { blob } = await git.readBlob({ fs: this.fs, dir: DIR, oid, cache: this.cache });
			return new TextDecoder().decode(blob);
		};
		await git.walk({
			fs: this.fs,
			dir: DIR,
			cache: this.cache,
			trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
			map: async (path, [a, b]) => {
				if (path === ".") return true;
				const [typeA, typeB] = [await a?.type(), await b?.type()];
				if (typeA === "tree" || typeB === "tree") {
					// Report the file on the blob side of a file/directory replacement,
					// while returning true lets the walker include all tree descendants.
					if ((typeA === "blob" || typeB === "blob") && typeA !== typeB) {
						changed.push({ path, before: await textAt(a, typeA), after: await textAt(b, typeB) });
					}
					return true;
				}
				const [oidA, oidB] = await Promise.all([a?.oid(), b?.oid()]);
				if (oidA !== oidB) changed.push({ path, before: await textAt(a, typeA), after: await textAt(b, typeB) });
				return true;
			},
		});
		return changed;
	}
}
