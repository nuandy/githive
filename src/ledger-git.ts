import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { BOT, type Remote } from "./git";
import { type LedgerEntry, ledgerMessage, noteLine, notesRef } from "./ledger";
import { MemoryFS } from "./memory-fs";

// Reading and writing a task's notes ref with isomorphic-git, in memory. A
// write fetches only the tip of the ref; a read fetches its whole history.

const DIR = "/ledger";

const onAuth = (remote: Remote) => () => ({ username: "x", password: remote.token.split("?expires=")[0] });

async function open(remote: Remote, ref: string, depth?: number) {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR });
	// isomorphic-git only fetches refs its remote's refspec maps; the default covers branches only.
	await git.addRemote({ fs, dir: DIR, remote: "origin", url: remote.url });
	await git.setConfig({ fs, dir: DIR, path: "remote.origin.fetch", value: "+refs/notes/*:refs/remotes/origin/notes/*" });
	try {
		const { fetchHead } = await git.fetch({ fs, http, dir: DIR, remote: "origin", ref, remoteRef: ref, singleBranch: true, tags: false, depth, onAuth: onAuth(remote) });
		if (fetchHead) await git.writeRef({ fs, dir: DIR, ref, value: fetchHead, force: true });
		return { fs, tip: fetchHead ?? null };
	} catch (err) {
		if (err instanceof git.Errors.NotFoundError) return { fs, tip: null }; // no decisions recorded yet
		throw err;
	}
}

/** Append decisions as notes on their commits, in one notes commit that carries the state patch. */
export async function appendLedger(remote: Remote, taskId: string, entries: LedgerEntry[], patch: unknown) {
	const ref = notesRef(taskId);
	for (let attempt = 1; ; attempt++) {
		const { fs, tip } = await open(remote, ref, 1);
		const notes = new Map<string, string>();
		if (tip) {
			const { commit } = await git.readCommit({ fs, dir: DIR, oid: tip });
			for (const e of (await git.readTree({ fs, dir: DIR, oid: commit.tree })).tree) notes.set(e.path, e.oid);
		}
		for (const [commit, lines] of groupBy(entries)) {
			const existing = notes.get(commit);
			const before = existing ? new TextDecoder().decode((await git.readBlob({ fs, dir: DIR, oid: existing })).blob).trimEnd() + "\n" : "";
			notes.set(commit, await git.writeBlob({ fs, dir: DIR, blob: new TextEncoder().encode(`${before}${lines.join("\n")}\n`) }));
		}
		const tree = await git.writeTree({ fs, dir: DIR, tree: [...notes].map(([path, oid]) => ({ mode: "100644", path, oid, type: "blob" as const })) });
		const signature = { ...BOT, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
		const oid = await git.writeCommit({
			fs,
			dir: DIR,
			commit: { message: ledgerMessage(entries, patch as never), tree, parent: tip ? [tip] : [], author: signature, committer: signature },
		});
		await git.writeRef({ fs, dir: DIR, ref, value: oid, force: true });
		try {
			await git.push({ fs, http, dir: DIR, url: remote.url, ref, remoteRef: ref, onAuth: onAuth(remote) });
			return oid;
		} catch (err) {
			// Someone else moved the ref (a restored copy of this task, say): rebuild on top of theirs.
			if (attempt >= 3 || !(err instanceof git.Errors.PushRejectedError)) throw err;
		}
	}
}

/** The notes commits' messages, oldest first. */
export async function readLedger(remote: Remote, taskId: string) {
	const ref = notesRef(taskId);
	const { fs, tip } = await open(remote, ref);
	if (!tip) return [];
	const log = await git.log({ fs, dir: DIR, ref });
	return log.reverse().map((c) => c.commit.message);
}

function groupBy(entries: LedgerEntry[]) {
	const byCommit = new Map<string, string[]>();
	for (const e of entries) byCommit.set(e.commit, [...(byCommit.get(e.commit) ?? []), noteLine(e)]);
	return byCommit;
}
