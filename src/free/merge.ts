import git from "isomorphic-git";
import type { CasLog } from "../election";
import { BOT, type Remote, Workspace } from "../git";
import { inLane } from "../open-mode";
import { release, type Registry } from "./claims";
import { approval, type ReviewPolicy, type Votes } from "./votes";

// The toolkit's merge for a cooperative agent in coordinator-free mode. It
// checks the conventions the agent follows (its claim covers every file it
// changed, no one else's claim does, the reviewed commit has the approvals, it
// merges into main without conflicts, and the project's checks pass on main
// plus the change) and refuses to help break them. It decides nothing that
// binds anyone: an agent can merge with plain git instead, and the audit sees
// the same records.

const ATTEMPTS = 3;

/** One check command's result. */
export interface CheckResult {
	command: string;
	exitCode: number;
	output: string;
}

/** Runs the project's checks on `base` (main) with `head` (from branch `ref`) merged in. Live, the Gate's container. */
export type CheckRunner = (input: { base: string; head: string; ref: string; commands: string[] }) => Promise<{ passed: boolean; results: CheckResult[] }>;

export interface MergeInput {
	remote: Remote;
	claims: CasLog<Registry>;
	votes: CasLog<Votes>;
	policy: ReviewPolicy;
	/** The project's checks; none means the merge isn't tested. */
	verify?: string[];
	runChecks?: CheckRunner;
	change: string;
	agent: string;
}

export type MergeOutcome =
	| { ok: true; commit: string }
	| { ok: false; reasons: string[]; conflicts?: string[]; checks?: CheckResult[] };

/**
 * Merge `changes/<change>` into main, with trailers naming the change, the
 * agent, and the claims and votes it checked; then release the claim, naming
 * the merge. If main moved meanwhile (another merge), check again and retry.
 */
export async function mergeChange(input: MergeInput): Promise<MergeOutcome> {
	for (let attempt = 1; ; attempt++) {
		const [claimsHead, votesHead] = await Promise.all([input.claims.read(), input.votes.read()]);
		const ws = await Workspace.clone(input.remote);
		const main = await ws.head();
		const head = await ws.fetch("change", input.remote, `changes/${input.change}`);
		const files = await ws.changedPaths(await ws.mergeBase(main, head), head);

		const reasons: string[] = [];
		const claims = claimsHead?.commit.state.claims ?? [];
		const own = claims.find((c) => c.change === input.change);
		if (!own) reasons.push(`${input.change} holds no claim`);
		for (const file of files) {
			const holder = claims.find((c) => c.change !== input.change && inLane(file, c.paths));
			if (holder) reasons.push(`${file} is inside ${holder.change}'s claim (${holder.agent})`);
			else if (own && !inLane(file, own.paths)) reasons.push(`${file} is outside ${input.change}'s claim`);
		}
		const outcome = approval(votesHead?.commit.state, head, input.policy);
		if (outcome.vetoedBy.length) reasons.push(`${head} is vetoed by ${outcome.vetoedBy.join(", ")}`);
		else if (!outcome.approved) reasons.push(`${head} has ${outcome.approvals} of ${input.policy.required} approvals`);
		if (reasons.length) return { ok: false, reasons };

		const tried = await ws.tryMerge(main, head);
		if (!tried.clean) {
			const files = tried.files ?? [];
			return {
				ok: false,
				conflicts: files,
				reasons: [`changes/${input.change} conflicts with main in ${files.join(", ")}: merge main into your branch, resolve inside your claim, push, and get the new commit approved`],
			};
		}

		// The project's checks, on main with the change merged in: what main would become.
		const verify = input.verify ?? [];
		if (verify.length) {
			if (!input.runChecks) throw new Error("[500] checks are configured but nothing can run them");
			const checked = await input.runChecks({ base: main, head, ref: `changes/${input.change}`, commands: verify });
			if (!checked.passed) {
				const failed = checked.results.find((r) => r.exitCode !== 0);
				return { ok: false, reasons: [failed ? `checks failed: ${failed.command} exited ${failed.exitCode}` : "checks failed"], checks: checked.results };
			}
		}

		const message = [
			`Merge ${input.change} by ${input.agent}`,
			"",
			`Blueprint-Change: ${input.change}`,
			`Blueprint-Agent: ${input.agent}`,
			`Blueprint-Claims: ${claimsHead!.tip}`,
			`Blueprint-Votes: ${votesHead!.tip}`,
			// Which main the checks passed on: the merge's first parent, if nothing moved.
			...(verify.length ? [`Blueprint-Tested: ${main}`] : []),
			"",
		].join("\n");
		// Always a merge commit, never a fast-forward: the merge's trailers are what the audit reads.
		const { oid } = await git.merge({ fs: ws.fs, dir: "/repo", ours: "main", theirs: head, message, author: BOT, fastForward: false, abortOnConflict: true });
		if (!oid) throw new Error(`merging ${input.change} made no commit`);
		try {
			await ws.push("main");
		} catch (err) {
			// Main moved under us: another agent merged first. Check again on top of it.
			if (attempt < ATTEMPTS && (err instanceof git.Errors.PushRejectedError || err instanceof git.Errors.GitPushError)) continue;
			throw err;
		}
		await release(input.claims, { change: input.change, agent: input.agent, reason: "merged", mergedAs: oid });
		return { ok: true, commit: oid };
	}
}
