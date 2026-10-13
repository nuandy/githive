import { useEffect, useRef } from "react";
import type { Undo } from "../../hooks/useUndo";
import { sentence } from "../../lib/errors";
import { cn } from "../../lib/utils";
import { Button } from "./button";

// After an action that can be taken back, a line where it happened: what was done and an Undo, for a while (useUndo).
// The row it was about has gone, so focus comes to the line, and Tab goes on to Undo. Undone, it says what's so again.

export function UndoLine({ undo, where, className }: { undo: Undo; where: string; className?: string }) {
	const { state } = undo;
	const shown = state.kind !== "idle" && state.where === where ? state : null;
	const line = useRef<HTMLParagraphElement>(null);
	const id = shown?.kind === "offered" && !shown.error ? shown.id : null;
	useEffect(() => {
		if (id !== null) line.current?.focus();
	}, [id]);
	// The live region is there before anything is said in it, so what's said is heard.
	return (
		<div data-slot="undo-line" role="status" className={className}>
			{shown ? (
				<p
					ref={line}
					tabIndex={-1}
					className={cn(
						"m-0 flex animate-appear flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-2 px-3 py-2 text-ui",
						"wrap-anywhere outline-offset-2",
					)}
				>
					<span>{shown.kind === "undone" ? shown.undone : shown.done}</span>
					{shown.kind === "undone" ? null : (
						<Button
							variant="link"
							className="touch-target text-ui font-semibold"
							disabled={shown.kind === "undoing"}
							onClick={() => void undo.undo()}
						>
							{shown.kind === "undoing" ? "Undoing…" : "Undo"}
						</Button>
					)}
					{shown.kind === "offered" && shown.error ? (
						<span className="basis-full text-bad">{sentence(`Couldn't undo: ${shown.error}`)} Try again.</span>
					) : null}
				</p>
			) : null}
		</div>
	);
}
