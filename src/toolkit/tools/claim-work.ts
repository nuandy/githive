import { fail, statusOf } from "../../errors";
import { type BacklogView, backlogFor } from "../work";
import { changeList } from "./claim-input";
import { claimChange } from "./claim-tools";
import { type Args, openCall, type ToolCall, type ToolHandlers } from "./context";
import { LISTED_AT_MOST } from "./repo";

// claim_work: the first free piece of the backlog among those the caller names, in its order, claimed in one call.
// Agents reading the same backlog at once often go for the same piece; the one that loses moves on to its next
// choice here, rather than waiting a turn to read the backlog again. Each piece is claimed as `claim` would claim
// it: its paths, its title and intent, and the pieces it lands after.

/** The most pieces one call may name: as many as `backlog` lists. */
export const MOST_PIECES_NAMED = LISTED_AT_MOST;

type FreePiece = BacklogView["open"][number];
type PassedOver = { piece: string; reason: string };

export const claimWorkTools: ToolHandlers = {
	async claim_work(call) {
		const agent = call.actAs("agent");
		const pieces = changeList(call.args.pieces, "pieces");
		if (!pieces.length) fail(400, "pieces names backlog pieces, in the order you'd take them");
		if (pieces.length > MOST_PIECES_NAMED) fail(400, `pieces names at most ${MOST_PIECES_NAMED} pieces`);
		const { open, waiting } = backlogFor(await call.openWork(agent));
		const passedOver: PassedOver[] = [];
		let attempt: ToolCall | undefined;
		for (const piece of pieces) {
			const free = open.find((item) => item.id === piece);
			if (!free) {
				passedOver.push({ piece, reason: notFree(piece, waiting) });
				continue;
			}
			// After a refusal, the claims are read again: the last read is what the refused claim raced against.
			attempt = attempt ? await openCall(attempt.args, call.ctx, call.run) : call;
			const claimed = await claimPiece(attempt, free);
			if (claimed.ok) return { ...claimed, ...(passedOver.length ? { passedOver } : {}) };
			passedOver.push({ piece, reason: claimed.reason });
		}
		return { ok: false, passedOver };
	},
};

/** Why a piece named isn't free to claim. */
function notFree(piece: string, waiting: BacklogView["waiting"]) {
	return waiting.find((item) => item.id === piece)?.reason ?? "not in the backlog, or merged already";
}

/** Claims one free piece as `claim` would; a refusal says why rather than failing the call. */
async function claimPiece(call: ToolCall, piece: FreePiece) {
	const args = claimArgs(call.args, piece);
	const reply = (await claimChange({ ...call, args }, { by: piece.by }).catch((err) => {
		if (statusOf(err).status !== 409) throw err;
		return { ok: false, refused: statusOf(err).message };
	})) as Record<string, unknown> & { ok?: boolean; refused?: string; conflicts?: { change: string; agent: string }[] };
	if (reply.ok) return { ...reply, ok: true as const, change: piece.id, intent: args.intent };
	const holder = reply.conflicts?.[0];
	const reason = holder ? `taken: overlaps ${holder.change} (${holder.agent})` : (reply.refused ?? "refused");
	return { ok: false as const, reason };
}

/** A claim's arguments for a piece: the call's own (repo, agent, into), with the piece's work. */
function claimArgs(args: Args, piece: FreePiece): Args {
	const { pieces: _, ...rest } = args;
	const intent = piece.intent ? `${piece.title}\n\n${piece.intent}` : piece.title;
	const after = piece.landsAfter ?? [];
	return { ...rest, change: piece.id, paths: piece.paths ?? [], intent, ...(after.length ? { after } : {}) };
}
