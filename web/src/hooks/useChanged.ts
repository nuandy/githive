import { useState } from "react";

/**
 * Whether `value` has been anything but its first since the component mounted. What changes later animates as it
 * comes in; what's there from the start arrives with its page, which animates already.
 */
export function useChanged(value: unknown): boolean {
	const [first] = useState(value);
	const [changed, setChanged] = useState(false);
	if (!changed && !Object.is(value, first)) setChanged(true);
	return changed;
}
