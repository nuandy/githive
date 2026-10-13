import { type ChangeState, STATES } from "../lib/status";
import { cn } from "../lib/utils";

/**
 * A change state's mark: a square in its color and pattern, its glyph on it, so color never says it alone (see
 * status.ts). Its caller sizes and rounds it; `glyph` sizes the glyph. Without a state it takes `empty`'s look, and
 * changes color smoothly as one comes and goes.
 */
export function StateMark({
	state,
	empty,
	className,
	glyph = "text-[9px]",
}: {
	state: ChangeState | undefined;
	empty?: string;
	className?: string;
	glyph?: string;
}) {
	const look = state ? STATES[state] : undefined;
	return (
		<span
			data-state={state}
			aria-hidden="true"
			className={cn(
				"inline-grid flex-none place-items-center border leading-none font-extrabold",
				"transition-[background-color,border-color,color] duration-slow",
				look ? look.mark : empty,
				className,
			)}
		>
			{look?.glyph ? <span className={glyph}>{look.glyph}</span> : null}
		</span>
	);
}
