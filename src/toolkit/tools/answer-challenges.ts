import { projectBranch } from "../../project-branch";
import type { NewsItem, Notice } from "../../repo-cache";
import type { Registry } from "../claims";
import type { ToolContext } from "./context";
import { storeFor } from "./repo";

// An agent asked whether it's still there answers by claiming again (see challenges.ts). Any call that brings it the
// question does that for it, so an agent at work never loses its claim for not reading its news in time.

type Challenged = Notice & { kind: "challenged"; change: string };

const isChallenged = (item: NewsItem): item is Challenged => item.kind === "challenged" && !!item.change;

/**
 * Claims again each change `agent` was asked about and still holds, and tells whoever asked. Answers with the changes
 * it claimed again; one it couldn't stays unanswered, and its asker may free it once the time is up.
 */
export async function answerChallenges(
	ctx: ToolContext,
	repo: string,
	registry: Registry,
	agent: string,
	news: NewsItem[],
): Promise<Set<string>> {
	const asked = news.filter(isChallenged);
	const answered = new Set<string>();
	if (!asked.length) return answered;
	const store = storeFor(ctx, repo, registry);
	const stamper = await ctx.stamper?.();
	for (const notice of asked) {
		if (answered.has(notice.change)) continue;
		const { claim } = await store.readChange(notice.change);
		if (claim?.agent !== agent) continue;
		const again = {
			change: claim.change,
			agent,
			paths: claim.paths,
			intent: claim.intent,
			...(claim.after?.length ? { after: claim.after } : {}),
			...(claim.source ? { source: claim.source } : {}),
		};
		const outcome = await store.claim(again, stamper).catch((err: unknown) => {
			console.error(`answering for ${agent} on ${notice.change} failed`, String(err));
			return null;
		});
		if (!outcome?.ok) continue;
		answered.add(notice.change);
		await tellAsker(ctx, repo, notice.branch ?? projectBranch(registry), { asked: notice, holder: agent });
	}
	return answered;
}

async function tellAsker(
	ctx: ToolContext,
	repo: string,
	branch: string,
	answer: { asked: Challenged; holder: string },
) {
	const { asked, holder } = answer;
	const asker = asked.from?.agent;
	if (!asker) return;
	await ctx.notify?.(repo, branch, [
		{
			agent: asker,
			notice: {
				kind: "answered",
				at: new Date().toISOString(),
				says: `${holder} answered: it's still working on ${asked.change}, so its claim stays.`,
				next: "Choose other work, or wait for it to release (`wait` hears it).",
				from: { agent: holder, change: asked.change },
			},
		},
	]);
}
