import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { CasLog, CommitKind, LogCommit } from "./election";
import { BOT, type Remote } from "./git";
import { type LedgerEntry, noteLine, notesRef } from "./ledger";
import { MemoryFS } from "./memory-fs";

// The elected coordinator's log in Git: the task's notes ref in the project
// repo. Reading fetches only the tip; appending pushes one commit on top of the
// tip it was built on, and Git rejects the push if the ref moved meanwhile.
//
// Each commit's tree holds the decisions as Git notes on the commits they are
// about (so `git notes --ref blueprint/<task> show <commit>` reads them), plus
// state.json (the task after this commit) and decisions.json (this commit's
// decisions, losslessly). Who leads, until when, and why the commit was made
// are trailers on its message.

const DIR = "/log";
const STATE_FILE = "state.json";
const DECISIONS_FILE = "decisions.json";

const TRAILERS = { term: "Blueprint-Term", leader: "Blueprint-Leader", leaseUntil: "Blueprint-Lease-Until", kind: "Blueprint-Kind", batch: "Blueprint-Batch" } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isCommitId = (id: string) => /^[0-9a-f]{40}$/.test(id);
const signature = () => ({ ...BOT, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 });

const onAuth = (remote: Remote) => () => ({ username: "x", password: remote.token.split("?expires=")[0] });

/** An empty in-memory repo with the ref's tip fetched, if the ref exists. */
async function openTip(remote: Remote, ref: string) {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR });
	await git.addRemote({ fs, dir: DIR, remote: "origin", url: remote.url });
	// isomorphic-git only fetches refs its remote's refspec maps; the default covers branches only.
	await git.setConfig({ fs, dir: DIR, path: "remote.origin.fetch", value: "+refs/notes/*:refs/remotes/origin/notes/*" });
	// Ask the server whether the log exists, rather than reading a fetch error as "empty".
	const refs = await git.listServerRefs({ http, url: remote.url, prefix: ref, onAuth: onAuth(remote) });
	if (!refs.some((r) => r.ref === ref)) return { fs, tip: null };
	const { fetchHead } = await git.fetch({ fs, http, dir: DIR, remote: "origin", ref, remoteRef: ref, singleBranch: true, tags: false, depth: 1, onAuth: onAuth(remote) });
	return { fs, tip: fetchHead ?? null };
}

export class GitCasLog<S> implements CasLog<S> {
	private readonly ref: string;

	constructor(
		private readonly remote: () => Promise<Remote>,
		taskId: string,
	) {
		this.ref = notesRef(taskId);
	}

	async read(): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		const { fs, tip } = await openTip(await this.remote(), this.ref);
		if (!tip) return null;
		const { commit } = await git.readCommit({ fs, dir: DIR, oid: tip });
		const trailer = (name: string) => commit.message.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? fail(`${tip} has no ${name} trailer`);
		const json = async (filepath: string) => JSON.parse(decoder.decode((await git.readBlob({ fs, dir: DIR, oid: tip, filepath })).blob));
		return {
			tip,
			commit: {
				term: Number(trailer(TRAILERS.term)),
				leader: trailer(TRAILERS.leader),
				leaseUntil: Number(trailer(TRAILERS.leaseUntil)),
				kind: trailer(TRAILERS.kind) as CommitKind,
				entries: (await json(DECISIONS_FILE)) as LedgerEntry[],
				state: (await json(STATE_FILE)) as S,
				batch: trailer(TRAILERS.batch),
			},
		};
	}

	async append(parent: string | null, commit: LogCommit<S>): Promise<string | null> {
		const remote = await this.remote();
		const { fs, tip } = await openTip(remote, this.ref);
		// Built on a stale tip: no need to ask the server.
		if (tip !== parent) return null;

		// Carry the notes forward, adding this commit's decisions to them.
		const files = new Map<string, string>();
		if (tip) {
			const { commit: previous } = await git.readCommit({ fs, dir: DIR, oid: tip });
			for (const entry of (await git.readTree({ fs, dir: DIR, oid: previous.tree })).tree) files.set(entry.path, entry.oid);
		}
		for (const [about, lines] of notesByCommit(commit.entries)) {
			const existing = files.get(about);
			const before = existing ? `${decoder.decode((await git.readBlob({ fs, dir: DIR, oid: existing })).blob).trimEnd()}\n` : "";
			files.set(about, await git.writeBlob({ fs, dir: DIR, blob: encoder.encode(`${before}${lines.join("\n")}\n`) }));
		}
		files.set(STATE_FILE, await git.writeBlob({ fs, dir: DIR, blob: encoder.encode(JSON.stringify(commit.state)) }));
		files.set(DECISIONS_FILE, await git.writeBlob({ fs, dir: DIR, blob: encoder.encode(JSON.stringify(commit.entries)) }));
		const tree = await git.writeTree({ fs, dir: DIR, tree: [...files].map(([path, oid]) => ({ mode: "100644", path, oid, type: "blob" as const })) });

		const oid = await git.writeCommit({
			fs,
			dir: DIR,
			commit: { message: message(commit), tree, parent: tip ? [tip] : [], author: signature(), committer: signature() },
		});
		await git.writeRef({ fs, dir: DIR, ref: this.ref, value: oid, force: true });
		try {
			const result = await git.push({ fs, http, dir: DIR, url: remote.url, ref: this.ref, remoteRef: this.ref, onAuth: onAuth(remote) });
			return result.ok ? oid : null;
		} catch (err) {
			// The ref moved between our read and our push: compare-and-swap lost.
			if (err instanceof git.Errors.PushRejectedError || err instanceof git.Errors.GitPushError) return null;
			throw err;
		}
	}
}

/** The commit message: a summary of the decisions, then the trailers. */
function message<S>(commit: LogCommit<S>) {
	const first = (text: string) => text.trim().split("\n")[0];
	const title = commit.entries.length ? first(commit.entries[0].text) : `${commit.kind[0].toUpperCase()}${commit.kind.slice(1)}: term ${commit.term}, ${commit.leader}`;
	const summary = commit.entries.map((e) => `- ${first(e.text)}`).join("\n");
	const trailers = [
		`${TRAILERS.term}: ${commit.term}`,
		`${TRAILERS.leader}: ${commit.leader}`,
		`${TRAILERS.leaseUntil}: ${commit.leaseUntil}`,
		`${TRAILERS.kind}: ${commit.kind}`,
		`${TRAILERS.batch}: ${commit.batch}`,
	].join("\n");
	return `${title}\n\n${summary ? `${summary}\n\n` : ""}${trailers}\n`;
}

/** Decision lines grouped by the commit they are about; decisions not about a commit live only in decisions.json. */
function notesByCommit(entries: LedgerEntry[]) {
	const byCommit = new Map<string, string[]>();
	for (const e of entries) if (isCommitId(e.commit)) byCommit.set(e.commit, [...(byCommit.get(e.commit) ?? []), noteLine(e)]);
	return byCommit;
}

function fail(message: string): never {
	throw new Error(message);
}
