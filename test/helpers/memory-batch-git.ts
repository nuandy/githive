import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { run, WORKDIR } from "../../src/container";
import { importFromGitHub } from "../../src/gate-github";
import { fetchBatchBase } from "../../src/gate-landing";
import { BOT, branchHead, type Remote, Workspace } from "../../src/git";
import { mergeMessage } from "../../src/toolkit/merge-commit";
import type { BatchGit, Inspected } from "../../src/toolkit/merge";
import { http, repoOfUrl } from "../../src/git-http";
import type { ReadHistory } from "../../src/toolkit/batch-reads";
import { treeLanding } from "../../src/toolkit/tree-landing";
import { gitHistory } from "./git-history";
import { gitAt } from "./git-server";
import { localContainer } from "./local-container";

// A batch's git work in memory, in this process, for tests: what the repo's
// Gate does with real git in its container (reading and landing batches, and
// the pushes to GitHub), done with isomorphic-git on a copy of the repo in
// memory. GitHive itself always does it in the Gate.

/**
 * A BatchGit that fetches each change in turn with its files since it left `base`, then lands them as
 * merge commits, stamped by the merge's stamper, in one push.
 */
export function memoryBatchGit(remote: Remote): BatchGit {
	const batchGit = inMemory(remote);
	// TREE_LANDING=1 lands batches with trees, as the Worker would, falling back to this in-memory landing.
	if (process.env.TREE_LANDING !== "1") return batchGit;
	const repos = gitAt(remote.url);
	const history: ReadHistory = (repo, read) => gitHistory(repos(repo))(repo, read);
	const land = treeLanding({
		history,
		project: repoOfUrl(remote.url),
		remote: async () => remote,
		fallback: batchGit.land,
	});
	return { ...batchGit, land };
}

function inMemory(remote: Remote): BatchGit {
	return {
		inspect: async ({ base, branch, changes }) => {
			const ws = await Workspace.at(remote, branch, base);
			const read: Inspected[] = [];
			for (const c of changes) {
				try {
					const head = await ws.fetch(`change-${c.change}`, c.source ?? remote, c.ref);
					read.push({ change: c.change, head, files: await ws.changedPaths(await ws.mergeBase(base, head), head) });
				} catch (err) {
					read.push({ change: c.change, error: String(err) });
				}
			}
			return read;
		},
		land: async ({ base, branch, merges, stamper }) => {
			const ws = await Workspace.at(remote, branch, base);
			if ((await ws.head()) !== base) return "moved";
			const commits: string[] = [];
			for (const m of merges) {
				await ws.fetch(`change-${m.change}`, m.source ?? remote, m.ref);
				const message = await mergeMessage({ ...m.claimed, base: await ws.head() }, stamper);
				const merged = await git
					.merge({
						fs: ws.fs,
						dir: "/repo",
						ours: ws.branch,
						theirs: m.head,
						message,
						author: BOT,
						fastForward: false,
						abortOnConflict: true,
					})
					.catch((err) => err as Error);
				// As the Gate says it: the change that didn't merge onto the batch, and its files.
				if (merged instanceof git.Errors.MergeConflictError)
					return { failed: `merging ${m.change} onto the batch failed`, conflict: conflictOf(m.change, merged) };
				if (merged instanceof Error) throw merged;
				if (!merged.oid) throw new Error(`merging ${m.change} made no commit`);
				commits.push(merged.oid);
			}
			// Only onto the base, as the Gate's push with a lease: looked at just before.
			if ((await branchHead(remote, branch)) !== base) return "moved";
			try {
				await ws.push();
				return { commits };
			} catch (err) {
				// As the Gate: an error can come after the push applied, and then the branch is at the last merge.
				if ((await branchHead(remote, branch).catch(() => null)) === commits.at(-1)) return { commits };
				if (err instanceof git.Errors.PushRejectedError || err instanceof git.Errors.GitPushError) return "moved";
				throw err;
			}
		},
		checksBranch: async ({ base, branch, changes, to, ref }) => {
			const ws = await Workspace.at(remote, branch, base);
			for (const c of changes) {
				const head = await ws.fetch(`change-${c.change}`, c.source ?? remote, c.ref).catch((err) => err as Error);
				if (head instanceof Error) return { failed: `fetch of ${c.change} failed: ${head.message}` };
				const merged = await ws.merge(c.head, `Check ${c.change} with the batch`).catch((err) => err as Error);
				if (merged instanceof Error) {
					const failed = `${c.change} doesn't merge onto the batch: ${merged.message}`;
					if (!(merged instanceof git.Errors.MergeConflictError)) return { failed };
					return { failed, conflict: conflictOf(c.change, merged) };
				}
			}
			const tip = await ws.head();
			await ws.pushAs(ws.branch, `refs/heads/${ref}`, to);
			return { tip };
		},
		pushBranch: async ({ branch, head, to, as }) => {
			const ws = await Workspace.at(remote, branch, head);
			// A fast-forward only, as the Gate's push.
			if (!as) return void (await ws.push(branch, to));
			await git.writeRef({ fs: ws.fs, dir: "/repo", ref: "refs/heads/pushing", value: head, force: true });
			const pushed = await git.push({ fs: ws.fs, http, dir: "/repo", url: to.url, ref: "pushing", remoteRef: as });
			if (!pushed.ok) throw new Error(`pushing ${as} was refused`);
		},
		// The Gate's own import, its commands run here with real git (see local-container.ts).
		importBranch: async ({ base, branch, from, githubBranch, as }) => {
			const dir = mkdtempSync(join(tmpdir(), "githive-import-"));
			try {
				const container = localContainer(dir) as unknown as Container;
				await run(container, ["git", "clone", "-q", remote.url, WORKDIR], "/");
				const project = { remote: remote.url, token: remote.token };
				const input = { repo: repoOfUrl(remote.url), branch, base: project, baseHead: base };
				await fetchBatchBase(container, input);
				const github = { remote: from.url, token: from.token, ...(from.user ? { user: from.user } : {}) };
				return await importFromGitHub(container, { ...input, from: github, githubBranch, as });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

const conflictOf = (change: string, err: InstanceType<typeof git.Errors.MergeConflictError>) => ({
	change,
	files: [...err.data.filepaths].sort(),
});
