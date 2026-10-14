import { type ChangeState, STATES } from "../lib/status";
import { cn } from "../lib/utils";

/**
 * A change state's mark: a square in its color and pattern, its glyph on it, so color never says it alone (see
 * status.ts). Its caller sizes and rounds it, 14px or more so the glyph's bold 10px reads; `glyph` sizes the glyph.
 * Without a state it takes `empty`'s look, and changes color smoothly as one comes and goes.
 */
export function StateMark({
	state,
	empty,
	className,
	glyph = "text-[10px] font-black",
}: {
	state: ChangeState | undefined;
	empty?: string;
	className?: string;
	glyph?: string;
}) {
	const look = state ? STATES[state] : undefined;
	// Overpass has no ✓ or ●, so they come from a fallback face, standing on Overpass's baseline, which sits lower
	// than the fallback's own would: raised by as much, they're in the square's middle, as ! and × are.
	const fallback = look?.glyph === "✓" || look?.glyph === "●";
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
			{look?.glyph ? <span className={cn(glyph, fallback && "relative -top-[0.15em]")}>{look.glyph}</span> : null}
		</span>
	);
}
