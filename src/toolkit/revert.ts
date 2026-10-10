import { FORMAT_TRAILER, RECORD_FORMAT } from "../record-format";
import git from "isomorphic-git";
import type { CasLog } from "../record-log";
import { BOT, type Remote, Workspace } from "../git";
import { type Violation, revertStampPayload } from "./audit";
import type { Registry } from "./claims";
import type { Stamper } from "./stamp";
import type { VoteStore } from "./vote-store";

// The remedy that goes with detection: any agent may
// revert a commit the audit reports. The revert restores the files that commit
// changed to how they were before it, as a commit on main that names what it
// reverts and, through the toolkit, who asked (stamped). The audit then marks
// the reverted commit's violations resolved.

const DIR = "/repo";
const ATTEMPTS = 3;

export interface RevertInput {
	remote: Remote;
	claims: CasLog<Registry>;
	votes: VoteStore;
	stamper?: Stamper;
	/** The project's branch. */
	branch: string;
	/** The commit on the branch to revert. */
	target: string;
	/** The audit's report: the target must have an open violation in it. */
	violations: Violation[];
	agent: string;
}

export type RevertOutcome = { ok: true; commit: string } | { ok: false; reasons: string[] };

export async function revertViolation(input: RevertInput): Promise<RevertOutcome> {
	if (!input.violations.some((v) => v.commit === input.target && !v.resolvedBy))
		return { ok: false, reasons: [`${input.target} has no reported violations to revert`] };
	for (let attempt = 1; ; attempt++) {
		const ws = await Workspace.clone(input.remote, input.branch);
		const head = await ws.head();
		const { commit } = await ws.ensureCommit(input.target);
		const before = commit.parent[0];
		if (!before) return { ok: false, reasons: [`${input.target} has no parent to revert to`] };
		const files = await ws.changedPaths(before, input.target);
		// Only a clean revert: a file changed again since would be clobbered.
		const since = new Set(await ws.changedPaths(input.target, head));
		const touched = files.filter((f) => since.has(f));
		if (touched.length) return { ok: false, reasons: touched.map((f) => `${f} has changed since; revert it by hand`) };

		for (const file of files) {
			const blob = await git.readBlob({ fs: ws.fs, dir: DIR, oid: before, filepath: file }).catch((err) => {
				if (err instanceof git.Errors.NotFoundError) return null;
				throw err;
			});
			if (blob) {
				await ws.fs.promises
					.mkdir(`${DIR}/${file.split("/").slice(0, -1).join("/")}`, { recursive: true } as never)
					.catch(() => {});
				await ws.fs.promises.writeFile(`${DIR}/${file}`, blob.blob);
				await git.add({ fs: ws.fs, dir: DIR, filepath: file });
			} else {
				await ws.fs.promises.unlink(`${DIR}/${file}`);
				await git.remove({ fs: ws.fs, dir: DIR, filepath: file });
			}
		}
		const rules = [...new Set(input.violations.filter((v) => v.commit === input.target).map((v) => v.rule))].join(", ");
		const stamp = input.stamper
			? await input.stamper.stamp(
					revertStampPayload({ base: head, reverts: input.target, author: input.agent, by: input.stamper.by }),
				)
			: undefined;
		const message = [
			`Revert ${input.target.slice(0, 8)} (${rules})`,
			"",
			`GitHive-Reverts: ${input.target}`,
			`${FORMAT_TRAILER}: ${RECORD_FORMAT}`,
			`GitHive-Agent: ${input.agent}`,
			...(input.stamper ? [`GitHive-By: ${input.stamper.by}`, `GitHive-Stamp: ${stamp}`] : []),
			"",
		].join("\n");
		const oid = await git.commit({ fs: ws.fs, dir: DIR, message, author: BOT });
		try {
			await ws.push();
		} catch (err) {
			// Main moved under us: look again on top of it.
			if (attempt < ATTEMPTS && (err instanceof git.Errors.PushRejectedError || err instanceof git.Errors.GitPushError))
				continue;
			throw err;
		}
		return { ok: true, commit: oid };
	}
}
