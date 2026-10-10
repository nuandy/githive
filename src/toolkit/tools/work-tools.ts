import { requiredString, statusOf } from "../../errors";
import { branchHead } from "../../git";
import { checkChange } from "../check";
import type { ClaimRecord } from "../claims";
import { lastLandedOn, type Settled } from "../landing";
import { addWork, addWorks, backlogFor, reviewsFor, type Work } from "../work";
import { changeStatus } from "./change-state";
import { workItemFrom } from "./claim-input";
import type { ToolCall, ToolHandlers } from "./context";
import { tellPeopleOfWaitingRoles } from "./dashboard";
import { branchSettings, DEFAULT_POLICY, LISTED_AT_MOST, MOST_AT_ONCE, recordLog, workRef } from "./repo";

// Tools agents use to choose their work: reviews, backlog, add_work, and status.

export const workTools: ToolHandlers = {
	async reviews({ ctx, repo, votes, registered, actAs, openWork }) {
		const agent = actAs("agent");
		const state = await openWork(agent);
		const held = ctx.reviews ? await ctx.reviews.held(repo).catch(() => ({})) : {};
		// Tell people about blocking-role reviews that waited too long. It runs when someone looks; no timer.
		if (ctx.reviews)
			await tellPeopleOfWaitingRoles(
				ctx,
				repo,
				votes,
				registered?.policy ?? DEFAULT_POLICY,
				state.open,
				state.votes,
				(claim) => branchSettings(registered, claim.into).policy,
			).catch((err) => console.error(`checking ${repo}'s waiting reviews failed`, String(err)));
		const options = reviewsFor({ ...state, held });
		return {
			reviews: options.slice(0, LISTED_AT_MOST),
			...(options.length > LISTED_AT_MOST ? { more: options.length - LISTED_AT_MOST } : {}),
		};
	},
	async backlog({ actAs, openWork }) {
		const { open, waiting } = backlogFor(await openWork(actAs("agent")));
		return {
			open: open.slice(0, LISTED_AT_MOST),
			...(open.length > LISTED_AT_MOST ? { more: open.length - LISTED_AT_MOST } : {}),
			waiting: waiting.slice(0, LISTED_AT_MOST),
			...(waiting.length > LISTED_AT_MOST ? { moreWaiting: waiting.length - LISTED_AT_MOST } : {}),
		};
	},
	async add_work({ args, ctx, repo, actAs }) {
		const by = actAs("agent");
		if (args.items !== undefined) {
			if (!Array.isArray(args.items) || !args.items.length || args.items.length > MOST_AT_ONCE)
				throw new Error(`[400] items is a list of 1 to ${MOST_AT_ONCE} pieces of work`);
			const items = args.items.map((item) => workItemFrom(item as Record<string, unknown>));
			const ids = items.map((item) => item.id);
			const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
			if (twice.length)
				throw new Error(`[400] each piece needs its own id: ${[...new Set(twice)].join(", ")} more than once`);
			const added = await addWorks(recordLog<Work>(ctx, repo, workRef(repo)), by, items);
			return { ok: added.ok, added: added.added, ...(added.already.length ? { already: added.already } : {}) };
		}
		const item = workItemFrom(args);
		const added = await addWork(recordLog<Work>(ctx, repo, workRef(repo)), { ...item, by });
		return added.ok ? { ok: true, id: item.id } : { ok: false, reason: added.refused };
	},
	async status(call) {
		const { args, ctx, repo, votes, registered, branch, changeOf, claimOf, waitingOn } = call;
		const change = requiredString(args, "change");
		const held = (await claimOf(change)) ?? null;
		const released = held ? undefined : (await changeOf(change)).released.at(-1);
		const votesOn = async (head: string) => (await votes.readFor([head])).votes;
		const waits = held?.after?.length ? await waitingOn(held.after, held.into ?? branch) : [];
		const status = await changeStatus(
			ctx,
			repo,
			registered,
			votesOn,
			change,
			held ?? undefined,
			held?.agent ?? released?.agent,
		);
		// A change can land before its claim is released (that waits for the lease to be handed on).
		// Report it, so its agent doesn't try to merge it again.
		let landed: Settled | undefined;
		if (held && status.head) {
			const landing = await ctx
				.landing?.(repo, held.into ?? branch)
				.view()
				.catch(() => null);
			landed = landing?.recent.findLast(
				(outcome) => outcome.change === change && outcome.head === status.head && outcome.how === "landed",
			);
		}
		const reply: Record<string, unknown> = { change, claim: held };
		if (released) reply.released = released;
		if (landed) reply.landed = { commit: landed.commit, at: landed.at };
		if (waits.length) reply.waitsOn = waits;
		Object.assign(reply, status);
		// Whether it merges cleanly and stays inside its claim: worth knowing before asking for review.
		if (held && status.head && !landed) {
			const checked = await mergeCheck(call, change, held, status.head).catch((err) => ({
				error: statusOf(err).message,
			}));
			reply.merge = checked;
		}
		return reply;
	},
};

/**
 * Whether a change merges cleanly into the branch it lands on (and who last changed any file it conflicts on),
 * and its files outside its claim. Worked out once per change head and branch head, so status stays cheap until
 * the agent pushes or the branch moves; worked out afresh, it warms the merge's check container.
 */
async function mergeCheck(call: ToolCall, change: string, own: ClaimRecord, head: string) {
	const { ctx, repo, branch, changeSource, warmChecks } = call;
	const into = own.into ?? branch;
	const project = await ctx.remote(repo, "read");
	const onto = ctx.branchHead ? await ctx.branchHead(repo, into) : await branchHead(project, into);
	if (!onto) throw new Error(`[409] ${into} doesn't exist yet`);
	const kept = await ctx.mergeChecks?.kept(repo, change).catch(() => null);
	if (kept?.key === `${head} ${onto}`) return kept.result;
	const source = await changeSource(own.agent, "read", change, own.since);
	const checked = await checkChange({
		project,
		branch: into,
		source,
		claims: [own],
		change,
		branchHead: async () => onto,
		...(ctx.history ? { history: ctx.history } : {}),
	});
	const conflicts = checked.main.clean ? [] : (checked.main.conflicts ?? []);
	const result = {
		into,
		branchHead: onto,
		clean: checked.main.clean,
		...(conflicts.length ? { conflicts, causes: await conflictCauses(call, into, conflicts) } : {}),
		outsideClaim: checked.outsideClaim,
	};
	// Kept under the head the check read, which may be newer than status's.
	await ctx.mergeChecks?.keep(repo, change, { key: `${checked.head} ${onto}`, result }).catch(() => undefined);
	await warmChecks("checked", change);
	return result;
}

/** Who last changed each conflicting file, as the landing remembers it: whom to ask about the conflict. */
async function conflictCauses({ ctx, repo }: ToolCall, into: string, conflicts: string[]) {
	const landing = await ctx
		.landing?.(repo, into)
		.view()
		.catch(() => null);
	return lastLandedOn(landing?.recent ?? [], conflicts);
}
