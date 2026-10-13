import { useEffect, useState } from "react";
import { reducedMotion } from "../lib/motion";

/**
 * True while `on` is, and for `ms` after: what it shows stays long enough to fold or fade away before it goes. Under
 * reduced motion nothing folds or fades, so it goes at once rather than stay, unseen, holding its room.
 */
export function useLingering(on: boolean, ms: number): boolean {
	const [lingering, setLingering] = useState(on);
	useEffect(() => {
		if (on) {
			setLingering(true);
			return;
		}
		const timer = setTimeout(() => setLingering(false), reducedMotion() ? 0 : ms);
		return () => clearTimeout(timer);
	}, [on, ms]);
	return on || (lingering && !reducedMotion());
}
