import { fail, requiredString, statusOf } from "../../errors";
import { branchHead } from "../../git";
import { checkChange } from "../check";
import type { ClaimRecord } from "../claims";
import { likelyEnvironment } from "../failure-hints";
import { type LandingView, lastLandedOn, type Settled } from "../landing";
import { conflictFix } from "../merge-ready";
import { leaseFor } from "../staleness";
import type { VotesView } from "../vote-store";
import { countedVotes, ownPersonsWork } from "../votes";
import { keepSteering, pieceHints, writtenSteering } from "../clef-hints";
import { STEERING_SAYS } from "../../steering";
import { addDependencies, addWork, addWorks } from "../backlog-records";
import { type BacklogView, backlogFor, reviewsFor, type Work, type WorkInput } from "../work";
import { changeSigns, changeStatus } from "./change-state";
import { changeList, workItemFrom } from "./claim-input";
import type { ToolCall, ToolContext, ToolHandlers } from "./context";
import { tellPeopleOfWaitingRoles } from "./dashboard";
import { onlyItsAgentCanReview } from "./no-reviewer";
import { claimPolicy, DEFAULT_POLICY, HOSTED_PREFIX, LISTED_AT_MOST, MOST_AT_ONCE, recordLog, workRef } from "./repo";

// Tools agents use to choose their work: reviews, backlog, add_work, and status.

export const workTools: ToolHandlers = {
	async reviews({ ctx, repo, votes, registered, actAs, openWork }) {
		const agent = actAs("agent");
		const limit = await ctx.ownerLimits?.reached("review");
		const state = await openWork(agent);
		const heads = state.open.flatMap((entry) => (entry.head ? [entry.head] : []));
		const held = ctx.reviews ? await ctx.reviews.held(repo, heads).catch(() => ({})) : {};
		// Tell people about blocking-role reviews that waited too long. It runs when someone looks; no timer.
		if (ctx.reviews)
			await tellPeopleOfWaitingRoles(
				ctx,
				repo,
				votes,
				registered?.policy ?? DEFAULT_POLICY,
				state.open,
				state.votes,
				(claim) => claimPolicy(registered, claim),
			).catch((err) => console.error(`checking ${repo}'s waiting reviews failed`, String(err)));
		const offered = await reviewOptions(ctx, repo, state, held);
		// Past the owner's limit on other people's work, only its own person's changes are offered.
		const own = new Set(
			state.open.filter(({ claim }) => ownPersonsWork(ctx.identity, claim.by)).map(({ claim }) => claim.change),
		);
		const options = limit ? offered.filter((option) => own.has(option.change)) : offered;
		return {
			...yoursIn(state),
			reviews: options.slice(0, LISTED_AT_MOST),
			...(options.length > LISTED_AT_MOST ? { more: options.length - LISTED_AT_MOST } : {}),
			...(limit ? { limit } : {}),
		};
	},
	async backlog({ ctx, actAs, openWork }) {
		const state = await openWork(actAs("agent"));
		const { open, waiting } = await withinOwnerLimits(ctx, backlogFor(state));
		return {
			...yoursIn(state),
			open: open.slice(0, LISTED_AT_MOST),
			...(open.length > LISTED_AT_MOST ? { more: open.length - LISTED_AT_MOST } : {}),
			waiting: waiting.slice(0, LISTED_AT_MOST),
			...(waiting.length > LISTED_AT_MOST ? { moreWaiting: waiting.length - LISTED_AT_MOST } : {}),
		};
	},
	async add_work(call) {
		const { args, ctx, repo, actAs } = call;
		const by = actAs("agent");
		if (args.piece !== undefined) return dependOn(call, by);
		if (args.items !== undefined) {
			if (!Array.isArray(args.items) || !args.items.length || args.items.length > MOST_AT_ONCE)
				fail(400, `items is a list of 1 to ${MOST_AT_ONCE} pieces of work`);
			const owned = (item: ReturnType<typeof workItemFrom>) => (ctx.identity ? { ...item, owner: ctx.identity } : item);
			const items = args.items.map((item) => owned(workItemFrom(item as Record<string, unknown>)));
			const ids = items.map((item) => item.id);
			const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
			if (twice.length) fail(400, `each piece needs its own id: ${[...new Set(twice)].join(", ")} more than once`);
			const hints = await piecesLikeOpenWork(call, items);
			const added = await addWorks(recordLog<Work>(ctx, repo, workRef(repo)), by, sized(items, hints.big));
			await keepPieceSteering(call, by, hints.steering);
			const reply = { ok: added.ok, added: added.added, ...(added.already.length ? { already: added.already } : {}) };
			return withPieceHints(reply, hints);
		}
		const item = workItemFrom(args);
		const hints = await piecesLikeOpenWork(call, [item]);
		const owner = ctx.identity ? { owner: ctx.identity } : {};
		const piece = { ...sized([item], hints.big)[0]!, by, ...owner };
		const added = await addWork(recordLog<Work>(ctx, repo, workRef(repo)), piece);
		if (!added.ok) return { ok: false, reason: added.refused };
		await keepPieceSteering(call, by, hints.steering);
		return withPieceHints({ ok: true, id: item.id }, hints);
	},
	async status(call) {
		const { args, ctx, repo, votes, registered, branch, changeOf, claimOf, waitingOn } = call;
		const change = requiredString(args, "change");
		const held = (await claimOf(change)) ?? null;
		const released = held ? undefined : (await changeOf(change)).released.at(-1);
		// The votes on a head (and the open questions to people), read once for its approval and its lease.
		const read = new Map<string, Promise<VotesView>>();
		const votesFor = (head: string | null) => {
			const key = head ?? "";
			if (!read.has(key)) read.set(key, votes.readFor(head ? [head] : []));
			return read.get(key)!;
		};
		const votesOn = async (head: string) => (await votesFor(head)).votes;
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
		let landing: LandingView | null = null;
		if (held && status.head) {
			landing =
				(await ctx
					.landing?.(repo, held.into ?? branch)
					.view()
					.catch(() => null)) ?? null;
			landed = landing?.recent.findLast(
				(outcome) => outcome.change === change && outcome.head === status.head && outcome.how === "landed",
			);
		}
		const reply: Record<string, unknown> = { change, claim: held };
		if (released) reply.released = released;
		if (landed) reply.landed = { commit: landed.commit, at: landed.at };
		// Clef's reading of the head's failed checks, when it found the environment likely to blame.
		const failedHere = landing?.recent.findLast(
			(outcome) => outcome.change === change && outcome.head === status.head && outcome.how === "failed",
		);
		if (failedHere && likelyEnvironment(failedHere)) reply.checksEnvironment = failedHere.environment;
		if (waits.length) reply.waitsOn = waits;
		Object.assign(reply, status);
		// When nobody else may give it the approvals it needs, its agent reviews it itself, in a fresh context.
		const alone = held && !landed ? await onlyItsAgentCanReview(call, held, status).catch(() => false) : false;
		if (alone) reply.reviewYourself = true;
		// How long the claim lasts if its agent goes quiet. Advice: a failed read leaves it out.
		if (held && !landed)
			reply.lease = await leaseOf(call, held, status.head, landing, votesFor).catch((err) => {
				console.error(`working out ${change}'s lease failed`, String(err));
				return undefined;
			});
		// What Clef made of the head's push: hints for its agent and its reviewers alike.
		if (status.head) {
			const kept = await ctx.pushHints?.(repo, change).catch(() => null);
			if (kept?.head === status.head && kept.hints.length) reply.hints = kept.hints;
		}
		const steering = await writtenSteering(ctx, repo, change);
		if (steering.length) reply.steering = steering;
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
 * What Clef sees in new pieces, as advice: a piece already in the backlog or an open change each may duplicate, and
 * one each may need first without saying so. Merged pieces exist already, so they're neither.
 */
async function piecesLikeOpenWork(call: ToolCall, pieces: Parameters<typeof pieceHints>[1]) {
	const { ctx, repo, adviceView } = call;
	const [backlog, advice] = await Promise.all([recordLog<Work>(ctx, repo, workRef(repo)).read(), adviceView()]);
	const merged = new Set(advice.merged);
	const items = (backlog?.commit.state.items ?? []).filter((item) => !merged.has(item.id));
	const existing = [
		...items.map((item) => ({ id: item.id, intent: `${item.title}: ${item.intent}` })),
		...advice.claims.map((claim) => ({ id: claim.change, intent: claim.intent })),
	];
	return pieceHints(ctx, pieces, existing);
}

function withPieceHints<R extends object>(reply: R, hints: Awaited<ReturnType<typeof pieceHints>>) {
	const { similar, mayNeed, big, steering } = hints;
	return {
		...reply,
		...(similar.length ? { similar } : {}),
		...(mayNeed.length ? { mayNeed } : {}),
		...(big.length ? { tooBig: big } : {}),
		...(steering.length ? { steering: steering.map((each) => ({ ...each, says: STEERING_SAYS })) } : {}),
	};
}

/** Keeps each flagged piece's flag under its id, which is its change's id once claimed. */
async function keepPieceSteering(call: ToolCall, by: string, flagged: { piece: string; likelihood: number }[]) {
	const keeps = flagged.map(({ piece, likelihood }) =>
		keepSteering(call.ctx, call.repo, piece, { in: "backlog piece", by, likelihood }),
	);
	await Promise.all(keeps);
}

/** Marks the pieces Clef found too big for one change, for whoever takes them from the backlog. */
const sized = <T extends { id: string }>(items: T[], big: string[]) =>
	items.map((item) => (big.includes(item.id) ? { ...item, big: true as const } : item));

/**
 * add_work with `piece`: adds what a piece already in the backlog waits on, such as a dependency Clef suggested. A
 * claimed piece is its agent's to order, with its claim's `after`.
 */
async function dependOn(call: ToolCall, by: string) {
	const { args, ctx, repo, claimOf } = call;
	const piece = requiredString(args, "piece");
	const after = changeList(args.after, "after");
	const landsAfter = changeList(args.lands_after, "lands_after");
	const named = [...after, ...landsAfter];
	if (!named.length) fail(400, "name what it waits on: after, lands_after or both");
	const claim = await claimOf(piece);
	if (claim) fail(409, `${piece} is claimed by ${claim.agent}: its claim's after is its agent's to set`);
	const added = await addDependencies(recordLog<Work>(ctx, repo, workRef(repo)), by, { piece, after, landsAfter });
	return added.ok ? { ok: true, piece, after, landsAfter } : { ok: false, reason: added.refused };
}

/**
 * The backlog as the caller's owner allows it: once the agent may build no more of other people's pieces today, they
 * wait, saying why. A piece with no recorded owner counts as someone else's.
 */
async function withinOwnerLimits(ctx: ToolContext, backlog: BacklogView): Promise<BacklogView> {
	const limit = await ctx.ownerLimits?.reached("build");
	if (!limit) return backlog;
	const others = (piece: BacklogView["open"][number]) => piece.owner !== ctx.identity;
	const held = backlog.open.filter(others).map((piece) => ({ id: piece.id, reason: `your owner's limit: ${limit}` }));
	return { open: backlog.open.filter((piece) => !others(piece)), waiting: [...backlog.waiting, ...held] };
}

/**
 * The caller's own open changes, and whether each has anything pushed, for the lists it reads before taking more
 * work: a claim it forgot, or one a failed call left in its name, shows up here. Read already, so it costs nothing.
 */
function yoursIn(state: WorkInput) {
	const mine = state.open.filter((entry) => entry.claim.agent === state.agent);
	if (!mine.length) return {};
	return { yours: mine.map((entry) => ({ change: entry.claim.change, pushed: entry.head !== null })) };
}

/** The reviews `state`'s agent may give, as `reviews` lists them, given the review holds in force. */
export async function reviewOptions(ctx: ToolContext, repo: string, state: WorkInput, held: Record<string, string[]>) {
	// A change GitHive's builder is still at gets more pushes: a review now would be of a commit it's replacing.
	const hosted = state.open.filter((entry) => entry.claim.agent.startsWith(HOSTED_PREFIX));
	const building = ctx.buildersAtWork
		? await ctx
				.buildersAtWork(
					repo,
					hosted.map((entry) => entry.claim.change),
				)
				.catch(() => new Set<string>())
		: new Set<string>();
	return reviewsFor({ ...state, held }).filter((option) => !building.has(option.change));
}

/** What renews a claim: claiming again makes it active now (see claims.ts). */
const RENEW = "claim the same paths again";

/**
 * How long a claim lasts if its agent goes quiet: whose turn its change is on, and, on its agent's turn, the time
 * after which its paths are free for anyone (see staleness.ts). Waiting on reviewers, a landing or a person, it lasts.
 */
async function leaseOf(
	call: ToolCall,
	claim: ClaimRecord,
	head: string | null,
	landing: LandingView | null,
	votesFor: (head: string | null) => Promise<VotesView>,
) {
	const { registered } = call;
	const record = await votesFor(head);
	const onHead = head ? record.votes.filter((vote) => vote.commit === head) : [];
	const counted = await countedVotes(onHead, registered?.stampKey);
	const policy = claimPolicy(registered, claim);
	return { ...leaseFor(changeSigns({ claim, head, counted, record, landing, policy })), renew: RENEW };
}

/**
 * Whether a change merges cleanly into the branch it lands on, and its files outside its claim. A conflict comes with
 * who changed each file (the landing's last change on it, and every commit since the change left the branch), the
 * files with their conflict markers, and the commands that resolve it. Worked out once per change head and branch
 * head, so status stays cheap until the agent pushes or the branch moves; worked out afresh, it warms the merge's
 * check container.
 */
async function mergeCheck(call: ToolCall, change: string, own: ClaimRecord, head: string) {
	const { ctx, repo, branch, changeSource, warmChecks } = call;
	const into = own.into ?? branch;
	const project = await ctx.remote(repo, "read");
	const onto = ctx.branchHead ? await ctx.branchHead(repo, into) : await branchHead(project, into);
	if (!onto) fail(409, `${into} doesn't exist yet`);
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
	const { main } = checked;
	const conflicts = main.clean ? [] : main.conflicts;
	const explained = main.clean
		? {}
		: {
				...(main.touchedBy ? { touchedBy: main.touchedBy } : {}),
				...(main.hunks ? { hunks: main.hunks } : {}),
				fix: conflictFix(into, change, conflicts),
			};
	const result = {
		into,
		branchHead: onto,
		clean: main.clean,
		...(conflicts.length ? { conflicts, causes: await conflictCauses(call, into, conflicts), ...explained } : {}),
		outsideClaim: checked.outsideClaim,
	};
	// Kept under the head the check read, which may be newer than status's. Hunks and touchedBy are capped, so the
	// entry stays small.
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
