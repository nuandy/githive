// JavaScript motion and the reader's wish for less of it. CSS motion follows prefers-reduced-motion in theme.css; what
// JavaScript moves or waits on (a glide, a row kept while it folds away) asks here.

/** Whether the reader asked for reduced motion. */
export function reducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How long to wait for something to move: `ms`, or nothing under reduced motion, where nothing moves. */
export function motionMs(ms: number): number {
	return reducedMotion() ? 0 : ms;
}
