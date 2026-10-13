import { type ReactNode, useState } from "react";
import { messageOf } from "../lib/errors";

/** Runs one action, keyed so its button shows it's busy; resolves to whether it worked. */
export type RunAction = (
	key: string,
	work: () => Promise<unknown>,
	onError?: (text: string) => void,
) => Promise<boolean>;

/**
 * The state a page's row actions share: which action is busy, which confirm question is open, and the error of
 * the row whose action failed last. A failed action's error goes to its `onError`, or else next to its row.
 */
export function useRowActions() {
	const [busy, setBusy] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ key: string; text: string } | null>(null);

	const run: RunAction = async (key, work, onError) => {
		setBusy(key);
		setRowError(null);
		try {
			await work();
			setConfirming(null);
			return true;
		} catch (err) {
			const text = messageOf(err);
			if (onError) onError(text);
			else setRowError({ key, text });
			return false;
		} finally {
			setBusy(null);
		}
	};
	const failed = (key: string) => (text: string) => setRowError({ key, text });
	const errorText = (key: string) => (rowError?.key === key ? rowError.text : null);
	const errorFor = (key: string): ReactNode => {
		const text = errorText(key);
		if (text === null) return null;
		return (
			<p className="m-0 animate-appear text-ui text-bad" role="alert">
				{text}
			</p>
		);
	};
	return { run, busy, confirming, setConfirming, failed, errorText, errorFor };
}
