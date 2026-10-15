import { presentClaim } from "../branch-scope";
import { answerBy, challenge, type Challenges, challengesRef } from "../challenges";
import type { ClaimRecord } from "../claims";
import type { Judge } from "./change-state";
import type { ToolCall } from "./context";
import { HOSTED_PREFIX, recordLog } from "./repo";

// A claim refused by claims in its way asks their holders whether they're still there (see challenges.ts). Only a
// holder the claim judged is asked: one idle long enough to judge, whose change waits on it. A change waiting on
// reviewers, a landing or a person is waiting its turn, and nobody asks.

export interface Judged {
	claim: ClaimRecord;
	judgement: Awaited<ReturnType<Judge>>;
}

/** What a refused claim tells its agent of a holder it asked. */
export interface Asked {
	change: string;
	holder: string;
	answerBy: string;
	note: string;
}

/** The abandoned rule, keeping each claim it judges and how, so a refused claim knows whom to ask. */
export function keepingJudged(judge: Judge, judged: Map<string, Judged>): Judge {
	return async (claim) => {
		const judgement = await judge(claim);
		judged.set(claim.change, { claim, judgement });
		return judgement;
	};
}

/**
 * Asks the holders of `changes` that the claim judged, still there and on their turn, whether they are. A holder
 * already asked isn't asked again, and only a new question reaches it, as a notice that rings its doorbell.
 */
export async function askHolders(call: ToolCall, judged: Map<string, Judged>, changes: string[]): Promise<Asked[]> {
	const by = call.actAs("agent");
	const asked: Asked[] = [];
	for (const change of new Set(changes)) {
		const seen = judged.get(change);
		if (!seen || seen.judgement.abandoned || seen.judgement.turn !== "agent") continue;
		if (seen.claim.agent === by) continue;
		if (await hostedAtWork(call, seen.claim)) continue;
		asked.push(await ask(call, seen.claim, by));
	}
	return asked;
}

// GitHive's hosted builders don't read news, so one still at work on its change isn't asked: it's there.
async function hostedAtWork(call: ToolCall, held: ClaimRecord) {
	if (!held.agent.startsWith(HOSTED_PREFIX) || !call.ctx.buildersAtWork) return false;
	const building = await call.ctx.buildersAtWork(call.repo, [held.change]).catch(() => new Set<string>());
	return building.has(held.change);
}

async function ask(call: ToolCall, held: ClaimRecord, by: string): Promise<Asked> {
	const { ctx, repo, branch } = call;
	const log = recordLog<Challenges>(ctx, repo, challengesRef(repo));
	const { challenge: open, opened } = await challenge(log, held, by);
	const until = answerBy(open).toISOString();
	if (opened) await tellHolder(call, presentClaim(held, branch).into ?? branch, open.holder, held.change, until);
	return {
		change: held.change,
		holder: open.holder,
		answerBy: until,
		note:
			`${open.holder} was asked whether it's still working on ${held.change}. If it doesn't answer by ${until}, ` +
			"claim again: its claim is released as stale and the paths are yours.",
	};
}

async function tellHolder(call: ToolCall, into: string, holder: string, change: string, until: string) {
	const by = call.actAs("agent");
	await call.ctx.notify?.(call.repo, into, [
		{
			agent: holder,
			notice: {
				kind: "challenged",
				at: new Date().toISOString(),
				change,
				says: `${by} is held up by your claim on ${change}, and asks whether you're still working on it.`,
				next:
					`Any call you make to GitHive by ${until} answers for you, by claiming ${change} again. ` +
					`If you're done with it, release ${change} so ${by} can go on.`,
				from: { agent: by },
				detail: { answerBy: until },
			},
		},
	]);
}
