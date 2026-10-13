import git, { type ReadCommitResult } from "isomorphic-git";
import { type Merged, merge3 } from "./diff3";
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
	/** Username sent with the token. Artifacts accepts any; GitHub App tokens need x-access-token. */
	user?: string;
}

/** Whether a ref listing failed only because the repo is empty and has no HEAD yet. */
export const isEmptyRepo = (err: unknown) =>
	(err as { code?: string })?.code === "NotFoundError" && /HEAD/.test(String((err as Error)?.message));

/** The branch the repo's HEAD points to, or null for an empty repo. This is the project's branch. */
export async function defaultBranch(remote: Remote): Promise<string | null> {
	const refs = await retryTransient(() =>
		git.listServerRefs({ http, url: remote.url, prefix: "HEAD", symrefs: true, ...gitAuth(remote) }),
	).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
	const target = refs.find((r) => r.ref === "HEAD")?.target;
	return target?.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : null;
}

/** A branch's head on a remote without cloning, or null when the branch doesn't exist. */
export async function branchHead(remote: Remote, branch: string): Promise<string | null> {
	const refs = await retryTransient(() =>
		git.listServerRefs({
			http,
			url: remote.url,
			protocolVersion: 1,
			prefix: `refs/heads/${branch}`,
			...gitAuth(remote),
		}),
	);
	return refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null;
}

/** A conflicted file with its conflict markers, cut to HUNK_BYTES around the conflicts (`truncated`) if longer. */
export interface Hunk {
	file: string;
	content: string;
	truncated: boolean;
}

export type MergeOutcome = { clean: true } | { clean: false; files: string[]; hunks?: Hunk[] };

/** The most of each conflicted file a test merge shows, and how many files it shows. */
export const HUNK_BYTES = 4096;
export const HUNK_FILES = 8;
// Lines shown around each conflict when a file is cut, and the largest file merged for its markers.
const HUNK_CONTEXT = 3;
const HUNK_SOURCE_BYTES = 256 * 1024;

/** A commit as the history readers see it (see branch-history.ts's CommitMeta). */
export interface CommitRead {
	hash: string;
	treeHash: string;
	message: string;
	author: { name: string };
	parents: string[];
	/** When it was committed, in Unix seconds. */
	committedAt?: number;
}

/** Commits of history a workspace starts with. It fetches more only when Git needs older commits. */
export const SHALLOW_DEPTH = 64;
/** Deep enough to mean all of history. */
const FULL_DEPTH = 1 << 20;

/**
 * Each workspace holds a copy of the project in memory, and an isolate shares
 * 128 MB across all its requests. Going over fails every request in the isolate,
 * so only this many work at once and the rest wait their turn.
 */
const WORKSPACES_AT_ONCE = 6;
const WORKSPACE_TURN_POLL_MS = 50;
let inWorkspaces = 0;

/**
 * Run `work` once fewer than WORKSPACES_AT_ONCE workspaces are in use. Waiting
 * polls on a timer: a request that only awaits a promise another request
 * resolves has nothing of its own pending, and the runtime cancels it as hung.
 */
export async function inWorkspaceTurn<T>(work: () => Promise<T>): Promise<T> {
	while (inWorkspaces >= WORKSPACES_AT_ONCE)
		await new Promise((resolve) => setTimeout(resolve, WORKSPACE_TURN_POLL_MS * (0.5 + Math.random())));
	inWorkspaces++;
	try {
		return await work();
	} finally {
		inWorkspaces--;
	}
}

/** Workspaces reused by `Workspace.at`, keyed by origin and branch, most recently used last. */
const kept = new Map<string, { head: string; workspace: Workspace }>();
const KEPT_WORKSPACES = 4;

/**
 * A repo in memory. It starts shallow because a whole project's history may not
 * fit in 128 MB. When an operation needs an older commit, such as the merge base
 * of a long-lived change, every fetched branch is deepened until Git has it.
 */
export class Workspace {
	/** What has been fetched, so it can be fetched again deeper. */
	private readonly sources: { remote: string; origin: Remote; ref: string }[] = [];
	/** isomorphic-git's read cache. Without it every read loads the packfile again. */
	private readonly cache = {};

	private constructor(
		readonly fs: MemoryFS,
		readonly origin: Remote,
		/** The project's branch. head, merge and push default to it. */
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
			// A failed clone can leave partial objects or refs behind, so each attempt starts fresh.
			const fs = new MemoryFS();
			await git.clone({
				fs,
				http,
				dir: DIR,
				url: origin.url,
				ref: branch,
				singleBranch: true,
				depth,
				...gitAuth(origin),
			});
			const workspace = new Workspace(fs, origin, branch, depth);
			workspace.sources.push({ remote: "origin", origin, ref: branch });
			return workspace;
		});
	}

	/**
	 * A read-only workspace with `branch` at `head`, such as for a check. It reuses a
	 * cached workspace when it can, fetching only what changed, and gives each caller
	 * its own copy. If the branch moved after `head` was read, it holds the newer head.
	 */
	static async at(origin: Remote, branch: string, head: string) {
		const key = `${origin.url}|${branch}`;
		const hit = kept.get(key);
		if (hit?.head === head) return hit.workspace.copy(origin);
		let workspace: Workspace;
		if (hit) {
			workspace = hit.workspace.copy(origin);
			await workspace.refreshBranch(origin);
		} else workspace = await Workspace.clone(origin, branch);
		kept.delete(key);
		kept.set(key, { head: await workspace.head(), workspace });
		while (kept.size > KEPT_WORKSPACES) kept.delete(kept.keys().next().value!);
		return workspace.copy(origin);
	}

	/** Fetches origin's branch and moves the local branch to it. The worktree is left as it was. */
	private async refreshBranch(origin: Remote) {
		const branch = this.branch;
		const result = await retryTransient(() =>
			git.fetch({
				fs: this.fs,
				http,
				dir: DIR,
				remote: "origin",
				ref: branch,
				singleBranch: true,
				depth: this.depth,
				...gitAuth(origin),
			}),
		);
		if (!result.fetchHead) throw new Error(`fetch of origin/${branch} returned no head`);
		// Reading needs the branch, not the files.
		await git.writeRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${branch}`, value: result.fetchHead, force: true });
	}

	/** An independent copy, fetching and deepening with `origin`'s credentials. */
	private copy(origin: Remote) {
		const copy = new Workspace(this.fs.copy(), origin, this.branch, this.depth);
		copy.sources.push(...this.sources.map((source) => (source.remote === "origin" ? { ...source, origin } : source)));
		return copy;
	}

	/** Fetch every known branch four times deeper. Returns false once history is complete. */
	private async deepen() {
		if (this.depth >= FULL_DEPTH) return false;
		this.depth = Math.min(this.depth * 4, FULL_DEPTH);
		for (const source of this.sources)
			await retryTransient(() =>
				git.fetch({
					fs: this.fs,
					http,
					dir: DIR,
					remote: source.remote,
					ref: source.ref,
					singleBranch: true,
					depth: this.depth,
					...gitAuth(source.origin),
				}),
			);
		return true;
	}

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

	/** Every file at the current head, by path. */
	files() {
		return git.listFiles({ fs: this.fs, dir: DIR, cache: this.cache });
	}

	/** Takes `paths` out of the worktree and the index, for the next commit. */
	async remove(paths: string[]) {
		for (const path of paths) {
			await this.fs.promises.unlink(`${DIR}/${path}`).catch(() => undefined);
			await git.remove({ fs: this.fs, dir: DIR, filepath: path });
		}
	}

	commit(message: string, author = BOT) {
		return git.commit({ fs: this.fs, dir: DIR, message, author });
	}

	/** Create branch `name` at the current head and push it. */
	async pushNewBranch(name: string) {
		await git.branch({ fs: this.fs, dir: DIR, ref: name, object: await this.head() });
		await this.push(name);
	}

	/** Force-push local ref `from` to `to` on `remote`. */
	pushAs(from: string, to: string, remote: Remote) {
		return retryTransient(() =>
			git.push({
				fs: this.fs,
				http,
				dir: DIR,
				url: remote.url,
				ref: from,
				remoteRef: to,
				force: true,
				...gitAuth(remote),
			}),
		);
	}

	push(ref = this.branch, remote: Remote = this.origin) {
		return retryTransient(() => git.push({ fs: this.fs, http, dir: DIR, url: remote.url, ref, ...gitAuth(remote) }));
	}

	/** Fetch `ref` from another repo into refs/remotes/<name>/<ref>; returns its commit. */
	async fetch(name: string, remote: Remote, ref = this.branch) {
		await git.addRemote({ fs: this.fs, dir: DIR, remote: name, url: remote.url, force: true });
		const result = await retryTransient(() =>
			git.fetch({
				fs: this.fs,
				http,
				dir: DIR,
				remote: name,
				ref,
				singleBranch: true,
				depth: this.depth,
				...gitAuth(remote),
			}),
		);
		if (!result.fetchHead) throw new Error(`fetch of ${name}/${ref} returned no head`);
		this.sources.push({ remote: name, origin: remote, ref });
		return result.fetchHead;
	}

	head(ref = this.branch) {
		return git.resolveRef({ fs: this.fs, dir: DIR, ref });
	}

	/** The best common ancestor of two commits, deepening history until it is found. */
	async mergeBase(first: string, second: string) {
		for (;;) {
			const oids = [await this.oid(first), await this.oid(second)];
			const [oid] = await git.findMergeBase({ fs: this.fs, dir: DIR, oids, cache: this.cache }).catch((err) => {
				if (err instanceof git.Errors.NotFoundError) return [];
				throw err;
			});
			if (oid) return oid as string;
			if (!(await this.deepen())) throw new Error(`no common ancestor for ${first} and ${second}`);
		}
	}

	private async oid(ref: string) {
		return /^[0-9a-f]{40}$/.test(ref) ? ref : git.resolveRef({ fs: this.fs, dir: DIR, ref });
	}

	/**
	 * Test-merge two refs without touching any branch. A conflict gives each conflicted file (the first HUNK_FILES)
	 * with its conflict markers, `ours` first and labelled as `labels` say, so an agent sees what it's reconciling
	 * before it fetches. Toolkit callers pass the agent's change as `ours`, as `git merge` in its clone shows it.
	 */
	async tryMerge(ours: string, theirs: string, labels = { ours: "ours", theirs: "theirs" }): Promise<MergeOutcome> {
		// Fetches the merge base if history is too shallow.
		const base = await this.mergeBase(ours, theirs);
		try {
			await git.merge({
				fs: this.fs,
				dir: DIR,
				ours,
				theirs,
				dryRun: true,
				abortOnConflict: true,
				author: BOT,
				cache: this.cache,
			});
			return { clean: true };
		} catch (err) {
			if (!(err instanceof git.Errors.MergeConflictError)) throw err;
			// Sorted, since the merge walks folders side by side and lists files in whatever order they finish.
			const files = [...err.data.filepaths].sort();
			// isomorphic-git's merge driver is told only a file's base name, so the sides are read again here.
			const hunks = await this.hunks(files.slice(0, HUNK_FILES), { base, ours, theirs }, labels).catch((failed) => {
				console.error("writing a conflict's markers failed", String(failed));
				return undefined;
			});
			return { clean: false, files, ...(hunks ? { hunks } : {}) };
		}
	}

	private async hunks(
		files: string[],
		at: { base: string; ours: string; theirs: string },
		labels: { ours: string; theirs: string },
	): Promise<Hunk[]> {
		const [base, ours, theirs] = await Promise.all([at.base, at.ours, at.theirs].map((ref) => this.oid(ref)));
		const hunks: Hunk[] = [];
		for (const file of files) {
			const [was, mine, other] = await Promise.all([base, ours, theirs].map((oid) => this.fileAt(oid!, file)));
			hunks.push({ file, ...hunkOf(was ?? null, mine ?? null, other ?? null, labels) });
		}
		return hunks;
	}

	// A file's bytes at a commit, or null where it doesn't exist.
	private async fileAt(commit: string, filepath: string): Promise<Uint8Array | null> {
		try {
			return (await git.readBlob({ fs: this.fs, dir: DIR, oid: commit, filepath, cache: this.cache })).blob;
		} catch (err) {
			if (err instanceof git.Errors.NotFoundError || err instanceof git.Errors.ObjectTypeError) return null;
			throw err;
		}
	}

	/**
	 * The first-parent chain from `from`, newest first, at most `most` commits, as far as this workspace holds it.
	 * It never fetches: a shallow workspace's chain ends where its history does.
	 */
	async firstParents(from: string, most: number): Promise<CommitRead[]> {
		const chain: CommitRead[] = [];
		let oid: string | undefined = await this.oid(from);
		while (oid && chain.length < most) {
			const read: ReadCommitResult | null = await git
				.readCommit({ fs: this.fs, dir: DIR, oid, cache: this.cache })
				.catch(() => null);
			if (!read) break;
			const commit: ReadCommitResult["commit"] = read.commit;
			chain.push({
				hash: oid,
				treeHash: commit.tree,
				message: commit.message,
				author: { name: commit.author.name },
				parents: commit.parent,
				committedAt: commit.committer.timestamp,
			});
			oid = commit.parent[0];
		}
		return chain;
	}

	/** A tree's entries as the history readers see them, or null if the workspace doesn't hold it. */
	async readTree(hash: string) {
		const read = await git.readTree({ fs: this.fs, dir: DIR, oid: hash, cache: this.cache }).catch(() => null);
		return (
			read?.tree.map((entry) => ({ name: entry.path, mode: entry.mode, hash: entry.oid, type: entry.type })) ?? null
		);
	}

	/** Merge `theirs` into the local branch. Throws MergeConflictError on conflict. */
	async merge(theirs: string, message: string) {
		await this.mergeBase(this.branch, theirs);
		return git.merge({
			fs: this.fs,
			dir: DIR,
			ours: this.branch,
			theirs,
			message,
			author: BOT,
			abortOnConflict: true,
			cache: this.cache,
		});
	}

	/** Paths whose content differs between two commits. */
	async changedPaths(from: string, to: string) {
		// Sequential because each may deepen history.
		await this.ensureCommit(await this.oid(from));
		await this.ensureCommit(await this.oid(to));
		const changed: string[] = [];
		await git.walk({
			fs: this.fs,
			dir: DIR,
			cache: this.cache,
			trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
			map: async (path, [fromEntry, toEntry]) => {
				if (path === ".") return true;
				const [fromType, toType] = [await fromEntry?.type(), await toEntry?.type()];
				// A file replaced by a directory, or the reverse, is a changed path whose
				// descendants still need visiting.
				if (fromType === "tree" || toType === "tree") {
					if ((fromType === "blob" || toType === "blob") && fromType !== toType) changed.push(path);
					// Identical trees need no walk.
					else if (fromType === toType && (await fromEntry?.oid()) === (await toEntry?.oid())) return null;
					return true;
				}
				if ((await fromEntry?.oid()) !== (await toEntry?.oid())) changed.push(path);
				return true;
			},
		});
		return changed;
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A conflicted file's content with its markers, cut around its conflicts when it's longer than HUNK_BYTES. */
function hunkOf(
	base: Uint8Array | null,
	ours: Uint8Array | null,
	theirs: Uint8Array | null,
	labels: { ours: string; theirs: string },
): { content: string; truncated: boolean } {
	// Deleted on one side and changed on the other: there are no lines to mark.
	if (!ours || !theirs)
		return {
			content: `deleted on ${ours ? labels.theirs : labels.ours}, changed on the other side\n`,
			truncated: false,
		};
	if ([base, ours, theirs].some((bytes) => bytes && (bytes.length > HUNK_SOURCE_BYTES || bytes.includes(0))))
		return { content: "binary or too large to show: both sides changed it\n", truncated: false };
	const text = (bytes: Uint8Array | null) => (bytes ? decoder.decode(bytes) : "");
	return shown(merge3(text(base), text(ours), text(theirs), labels));
}

// The merged text whole if it fits, else each conflict with a few lines around it, headed by where it starts.
function shown({ lines, conflicts }: Merged): { content: string; truncated: boolean } {
	const whole = lines.join("");
	if (encoder.encode(whole).length <= HUNK_BYTES) return { content: whole, truncated: false };
	const windows: [number, number][] = [];
	for (const [start, end] of conflicts) {
		const from = Math.max(0, start - HUNK_CONTEXT);
		const to = Math.min(lines.length, end + HUNK_CONTEXT);
		const last = windows.at(-1);
		if (last && from <= last[1]) last[1] = Math.max(last[1], to);
		else windows.push([from, to]);
	}
	const excerpt = windows.map(([from, to]) => `@@ line ${from + 1} @@\n${lines.slice(from, to).join("")}`).join("");
	return { content: clipped(excerpt || whole, HUNK_BYTES), truncated: true };
}

// The text cut to at most `most` bytes of UTF-8, at the start of a character.
function clipped(text: string, most: number) {
	const bytes = encoder.encode(text);
	if (bytes.length <= most) return text;
	let end = most;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return decoder.decode(bytes.subarray(0, end));
}
