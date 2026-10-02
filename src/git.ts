import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { retryTransient } from "./retry";

// The Artifacts binding manages repos but cannot write inside them, so every
// commit, merge and push goes through isomorphic-git over an in-memory tree.

const DIR = "/repo";

export const BOT = { name: "Blueprint", email: "bot@blueprint.invalid" };

export interface Remote {
	url: string;
	token: string;
}

// Artifacts tokens look like art_v1_<secret>?expires=<unix>; Git auth wants only the secret.
const onAuth = (remote: Remote) => () => ({
	username: "x",
	password: remote.token.split("?expires=")[0],
});

export type MergeOutcome = { clean: true } | { clean: false; files: string[] };

export class Workspace {
	private constructor(
		readonly fs: MemoryFS,
		readonly origin: Remote,
	) {}

	/** Start an empty repo whose origin is a freshly created Artifacts repo. */
	static async init(origin: Remote) {
		const fs = new MemoryFS();
		await git.init({ fs, dir: DIR, defaultBranch: "main" });
		return new Workspace(fs, origin);
	}

	static async clone(origin: Remote, ref = "main") {
		return retryTransient(async () => {
			// A failed clone may have populated part of the object database, refs, or
			// worktree. Each attempt must therefore begin with an entirely fresh FS.
			const fs = new MemoryFS();
			await git.clone({ fs, http, dir: DIR, url: origin.url, ref, singleBranch: true, onAuth: onAuth(origin) });
			return new Workspace(fs, origin);
		});
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

	push(ref = "main", remote: Remote = this.origin) {
		return retryTransient(() => git.push({ fs: this.fs, http, dir: DIR, url: remote.url, ref, onAuth: onAuth(remote) }));
	}

	/** Fetch `ref` from another repo into refs/remotes/<name>/<ref>; returns its commit. */
	async fetch(name: string, remote: Remote, ref = "main") {
		await git.addRemote({ fs: this.fs, dir: DIR, remote: name, url: remote.url, force: true });
		const result = await retryTransient(() => git.fetch({
			fs: this.fs,
			http,
			dir: DIR,
			remote: name,
			ref,
			singleBranch: true,
			onAuth: onAuth(remote),
		}));
		if (!result.fetchHead) throw new Error(`fetch of ${name}/${ref} returned no head`);
		return result.fetchHead;
	}

	head(ref = "main") {
		return git.resolveRef({ fs: this.fs, dir: DIR, ref });
	}

	/** The best common ancestor of two commits. */
	async mergeBase(a: string, b: string) {
		const [oid] = await git.findMergeBase({ fs: this.fs, dir: DIR, oids: [a, b] });
		if (!oid) throw new Error(`no common ancestor for ${a} and ${b}`);
		return oid as string;
	}

	/** Test-merge two refs without touching any branch. */
	async tryMerge(ours: string, theirs: string): Promise<MergeOutcome> {
		try {
			await git.merge({ fs: this.fs, dir: DIR, ours, theirs, dryRun: true, abortOnConflict: true, author: BOT });
			return { clean: true };
		} catch (err) {
			if (err instanceof git.Errors.MergeConflictError) return { clean: false, files: err.data.filepaths };
			throw err;
		}
	}

	/** Merge `theirs` into local main. Throws MergeConflictError on conflict. */
	merge(theirs: string, message: string) {
		return git.merge({ fs: this.fs, dir: DIR, ours: "main", theirs, message, author: BOT, abortOnConflict: true });
	}

	/** Paths whose content differs between two commits. */
	async changedPaths(from: string, to: string) {
		const changed: string[] = [];
		await git.walk({
			fs: this.fs,
			dir: DIR,
			trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
			map: async (path, [a, b]) => {
				if (path === ".") return true;
				const [typeA, typeB] = [await a?.type(), await b?.type()];
				// Descend into directories; only files are reported.
				if (typeA === "tree" || typeB === "tree") return true;
				if ((await a?.oid()) !== (await b?.oid())) changed.push(path);
				return true;
			},
		});
		return changed;
	}
}
