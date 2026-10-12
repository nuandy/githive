import { GitCasLog } from "../../src/record-log";
import type { Registry } from "../../src/toolkit/claims";
import type { GitServer } from "./git-server";

/** Writes repo `repo`'s GitHub link as GitHive wrote it before modes existed: the GitHub repo alone. */
export async function linkBeforeModes(server: GitServer, repo: string, github: string) {
	const log = new GitCasLog<Registry>(
		async () => ({ url: server.url, token: "unused" }),
		repo,
		`refs/notes/githive-claims/${repo}`,
	);
	const head = await log.read();
	const state: Registry = { ...head!.commit.state, github: { repo: github } };
	await log.append(head!.tip, {
		author: "githive",
		kind: "decisions",
		entries: [{ commit: "none", text: "a link from before modes", at: new Date().toISOString() }],
		state,
		batch: crypto.randomUUID(),
	});
}
