import type { ReadHistory } from "../../src/toolkit/batch-reads";

/** Artifacts' history API (log, readTree) over a test server's repo, answered by git itself (`git` runs it there). */
export const gitHistory =
	(git: (...args: string[]) => string): ReadHistory =>
	(_repo, read) =>
		read({
			log: async (ref, limit, offset) =>
				git("log", "--first-parent", `--max-count=${limit}`, `--skip=${offset}`, "--format=%H %T %P", ref)
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const [hash, tree, ...parents] = line.split(" ") as [string, string, ...string[]];
						return { hash, treeHash: tree, message: "", author: { name: "" }, parents };
					}),
			readCommit: async () => null,
			readTree: async (hash) =>
				git("ls-tree", hash)
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const [meta, name] = line.split("\t") as [string, string];
						const [mode, type, oid] = meta.split(" ") as [string, string, string];
						return { name, mode, type, hash: oid };
					}),
		});
