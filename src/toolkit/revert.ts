import { FORMAT_TRAILER, RECORD_FORMAT } from "../record-format";
import git from "isomorphic-git";
import type { CasLog } from "../record-log";
import { BOT, type Remote, Workspace } from "../git";
import { type Violation, revertStampPayload } from "./audit";
import type { Registry } from "./claims";
import type { Stamper } from "./stamp";
import type { VoteStore } from "./vote-store";

// Any agent may revert a commit the audit reports. The revert restores the files that commit changed, as a
// stamped commit on main that names what it reverts, and the audit then marks those violations resolved.

const DIR = "/repo";
const ATTEMPTS = 3;

export interface RevertInput {
	remote: Remote;
	claims: CasLog<Registry>;
	votes: VoteStore;
	stamper?: Stamper;
	branch: string;
	target: string;
	/** The audit's report. The target must have an open violation in it. */
	violations: Violation[];
	agent: string;
}

export type RevertOutcome = { ok: true; commit: string } | { ok: false; reasons: string[] };

export async function revertViolation(input: RevertInput): Promise<RevertOutcome> {
	if (!input.violations.some((violation) => violation.commit === input.target && !violation.resolvedBy))
		return { ok: false, reasons: [`${input.target} has no reported violations to revert`] };
	for (let attempt = 1; ; attempt++) {
		const workspace = await Workspace.clone(input.remote, input.branch);
		const head = await workspace.head();
		const { commit } = await workspace.ensureCommit(input.target);
		const before = commit.parent[0];
		if (!before) return { ok: false, reasons: [`${input.target} has no parent to revert to`] };
		const files = await workspace.changedPaths(before, input.target);
		// Refuse unless the revert is clean, since a file changed after the target would be clobbered.
		const since = new Set(await workspace.changedPaths(input.target, head));
		const touched = files.filter((file) => since.has(file));
		if (touched.length)
			return { ok: false, reasons: touched.map((file) => `${file} has changed since; revert it by hand`) };

		await restoreFiles(workspace, before, files);
		const message = await revertMessage(input, head);
		const oid = await git.commit({ fs: workspace.fs, dir: DIR, message, author: BOT });
		try {
			await workspace.push();
		} catch (err) {
			// Main moved, so try again on top of it.
			if (attempt < ATTEMPTS && (err instanceof git.Errors.PushRejectedError || err instanceof git.Errors.GitPushError))
				continue;
			throw err;
		}
		return { ok: true, commit: oid };
	}
}

// Stages each file as it was at `before`, deleting those that didn't exist then.
async function restoreFiles(workspace: Workspace, before: string, files: string[]) {
	const { fs } = workspace;
	for (const file of files) {
		const blob = await git.readBlob({ fs, dir: DIR, oid: before, filepath: file }).catch((err) => {
			if (err instanceof git.Errors.NotFoundError) return null;
			throw err;
		});
		if (blob) {
			await fs.promises
				.mkdir(`${DIR}/${file.split("/").slice(0, -1).join("/")}`, { recursive: true } as never)
				.catch(() => {});
			await fs.promises.writeFile(`${DIR}/${file}`, blob.blob);
			await git.add({ fs, dir: DIR, filepath: file });
		} else {
			await fs.promises.unlink(`${DIR}/${file}`);
			await git.remove({ fs, dir: DIR, filepath: file });
		}
	}
}

// The revert's message: what it reverts and why, with GitHive's stamp over its trailers.
async function revertMessage(input: RevertInput, head: string) {
	const reported = input.violations.filter((violation) => violation.commit === input.target);
	const rules = [...new Set(reported.map((violation) => violation.rule))].join(", ");
	const stamp = input.stamper
		? await input.stamper.stamp(
				revertStampPayload({ base: head, reverts: input.target, author: input.agent, by: input.stamper.by }),
			)
		: undefined;
	return [
		`Revert ${input.target.slice(0, 8)} (${rules})`,
		"",
		`GitHive-Reverts: ${input.target}`,
		`${FORMAT_TRAILER}: ${RECORD_FORMAT}`,
		`GitHive-Agent: ${input.agent}`,
		...(input.stamper ? [`GitHive-By: ${input.stamper.by}`, `GitHive-Stamp: ${stamp}`] : []),
		"",
	].join("\n");
}
