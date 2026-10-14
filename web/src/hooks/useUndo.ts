import { useCallback, useEffect, useReducer, useRef } from "react";
import { reasonOf } from "../lib/errors";

/** How long an action that can be taken back offers Undo. */
export const UNDO_MS = 10_000;

/** What an Undo offer holds: where on the page it shows, what was done, and the call that takes it back. */
interface Offer {
	id: number;
	/** Which part of the page the line shows in. */
	where: string;
	/** What was done, as the line says it. */
	done: string;
	/** What's so once it's undone. */
	undone: string;
	undo: () => Promise<unknown>;
}

export type UndoState =
	| { kind: "idle" }
	| ({ kind: "offered"; error?: string } & Offer)
	| ({ kind: "undoing"; error?: undefined } & Offer)
	| ({ kind: "undone" } & Offer);

type UndoAction =
	| ({ type: "offer" } & Offer)
	| { type: "expire" | "start" | "undone"; id: number }
	| { type: "failed"; id: number; error: string };

/**
 * The undo line's next state. A new action takes the place of an older one; time running out, or a call's answer,
 * only counts for the line it was about. A line isn't taken away while its Undo is under way.
 */
export function undoStep(state: UndoState, action: UndoAction): UndoState {
	if (action.type === "offer") {
		const { type: _, ...offer } = action;
		return { kind: "offered", ...offer };
	}
	if (state.kind === "idle" || state.id !== action.id) return state;
	switch (action.type) {
		case "expire":
			return state.kind === "undoing" ? state : { kind: "idle" };
		case "start":
			return state.kind === "offered" ? { ...state, kind: "undoing", error: undefined } : state;
		case "undone":
			return state.kind === "undoing" ? { ...state, kind: "undone" } : state;
		case "failed":
			return state.kind === "undoing" ? { ...state, kind: "offered", error: action.error } : state;
	}
}

/**
 * A page's undo line: `offer` what was just done and the call that takes it back, and the line (UndoLine) says so with
 * an Undo for UNDO_MS. Undone, it says so for as long again; a failed Undo says why and can be tried again.
 */
export function useUndo(ms = UNDO_MS) {
	const [state, dispatch] = useReducer(undoStep, { kind: "idle" });
	const next = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const expireLater = useCallback(
		(id: number) => {
			clearTimeout(timer.current);
			timer.current = setTimeout(() => dispatch({ type: "expire", id }), ms);
		},
		[ms],
	);
	useEffect(() => () => clearTimeout(timer.current), []);

	const offer = useCallback(
		(where: string, words: { done: string; undone: string }, undo: () => Promise<unknown>) => {
			next.current += 1;
			dispatch({ type: "offer", id: next.current, where, ...words, undo });
			expireLater(next.current);
		},
		[expireLater],
	);
	const undo = async () => {
		if (state.kind !== "offered") return;
		const { id } = state;
		dispatch({ type: "start", id });
		try {
			await state.undo();
			dispatch({ type: "undone", id });
		} catch (err) {
			// The server's words, set in the line's own sentence.
			dispatch({ type: "failed", id, error: reasonOf(err) });
		}
		expireLater(id);
	};
	return { state, offer, undo };
}

export type Undo = ReturnType<typeof useUndo>;
