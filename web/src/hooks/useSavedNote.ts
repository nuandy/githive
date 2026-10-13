import { useEffect, useRef, useState } from "react";

/** How long "Saved" stays by what was changed at once (a role, a permission). */
export const SAVED_MS = 4_000;

/** Which row just saved, said for a while: `note(key)` after a change that applied at once. */
export function useSavedNote(ms = SAVED_MS) {
	const [saved, setSaved] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const note = (key: string) => {
		clearTimeout(timer.current);
		setSaved(key);
		timer.current = setTimeout(() => setSaved(null), ms);
	};
	return { saved, note };
}
