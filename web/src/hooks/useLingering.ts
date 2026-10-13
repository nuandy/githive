import { useEffect, useState } from "react";

/** True while `on` is, and for `ms` after: what it shows stays long enough to fold or fade away before it goes. */
export function useLingering(on: boolean, ms: number): boolean {
	const [lingering, setLingering] = useState(on);
	useEffect(() => {
		if (on) {
			setLingering(true);
			return;
		}
		const timer = setTimeout(() => setLingering(false), ms);
		return () => clearTimeout(timer);
	}, [on, ms]);
	return on || lingering;
}
