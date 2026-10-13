import { type ChangeState, STATES } from "../lib/status";
import { cn } from "../lib/utils";

/**
 * A change state's mark: a square in its color and pattern, its glyph on it, so color never says it alone (see
 * status.ts). Its caller sizes and rounds it; `glyph` sizes the glyph.
 */
export function StateMark({
	state,
	className,
	glyph = "text-[9px]",
}: {
	state: ChangeState;
	className?: string;
	glyph?: string;
}) {
	const look = STATES[state];
	return (
		<span
			data-state={state}
			aria-hidden="true"
			className={cn(
				"inline-grid flex-none place-items-center border leading-none font-extrabold",
				"transition-[background-color,border-color,color] duration-slow",
				look.mark,
				className,
			)}
		>
			{look.glyph ? <span className={glyph}>{look.glyph}</span> : null}
		</span>
	);
}
