import type { ReadHistory } from "../../src/toolkit/batch-reads";

// Fields split by unit separators and commits by record separators, since a message spans lines.
const FORMAT = "--format=%H%x1f%T%x1f%an%x1f%P%x1f%B%x1e";

/**
 * Artifacts' history API (log, readTree, readBlob) over a test server's repo, answered by git itself (`git` runs it
 * there). Blobs are read as text, which the tests' files are.
 */
export const gitHistory =
	(git: (...args: string[]) => string): ReadHistory =>
	(_repo, read) =>
		read({
			log: async (ref, limit, offset) =>
				git("log", "--first-parent", `--max-count=${limit}`, `--skip=${offset}`, FORMAT, ref)
					.split("\x1e")
					.map((entry) => entry.replace(/^\n/, ""))
					.filter(Boolean)
					.map((entry) => {
						const [hash = "", treeHash = "", name = "", parents = "", message = ""] = entry.split("\x1f");
						return {
							hash,
							treeHash,
							// As Artifacts does, with one trailing newline removed.
							message: message.replace(/\n$/, ""),
							author: { name },
							parents: parents.split(" ").filter(Boolean),
						};
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
			readBlob: async (hash) => {
				// As Artifacts does: null for an object that's missing or isn't a blob.
				try {
					git("cat-file", "-e", hash);
				} catch {
					return null;
				}
				if (git("cat-file", "-t", hash).trim() !== "blob") return null;
				return new TextEncoder().encode(git("cat-file", "blob", hash));
			},
		});
