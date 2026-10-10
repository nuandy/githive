import { requiredString } from "../../errors";
import { addWork, addWorks, backlogFor, reviewsFor, type Work } from "../work";
import { changeStatus } from "./change-state";
import { workItemFrom } from "./claim-input";
import type { ToolHandlers } from "./context";
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
			const ids = items.map((i) => i.id);
			const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
			if (twice.length)
				throw new Error(`[400] each piece needs its own id: ${[...new Set(twice)].join(", ")} more than once`);
			const added = await addWorks(recordLog<Work>(ctx, repo, workRef(repo)), by, items);
			return { ok: added.ok, added: added.added, ...(added.already.length ? { already: added.already } : {}) };
		}
		const item = workItemFrom(args);
		const added = await addWork(recordLog<Work>(ctx, repo, workRef(repo)), { ...item, by });
		return added.ok ? { ok: true, id: item.id } : { ok: false, reason: added.refused };
	},
	async status({ args, ctx, repo, votes, registered, branch, changeOf, claimOf, waitingOn }) {
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
		const landed =
			held && status.head
				? (
						await ctx
							.landing?.(repo, held.into ?? branch)
							.view()
							.catch(() => null)
					)?.recent.findLast((s) => s.change === change && s.head === status.head && s.how === "landed")
				: undefined;
		return {
			change,
			claim: held,
			...(released ? { released } : {}),
			...(landed ? { landed: { commit: landed.commit, at: landed.at } } : {}),
			...(waits.length ? { waitsOn: waits } : {}),
			...status,
		};
	},
};
