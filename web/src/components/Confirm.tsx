/**
 * A destructive action asked twice, in the page (never confirm()): the first
 * click asks the question, the second does it. One question is open at a
 * time; `confirming` says which.
 */
export function ConfirmButton({
	id,
	confirming,
	setConfirming,
	label,
	question,
	busy,
	onConfirm,
}: {
	id: string;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	label: string;
	question: string;
	busy: boolean;
	onConfirm: () => void;
}) {
	if (confirming !== id)
		return (
			<button type="button" className="danger manage__small" onClick={() => setConfirming(id)} disabled={busy}>
				{label}
			</button>
		);
	return (
		<span className="manage__confirm" role="group" aria-label={question}>
			<span>{question}</span>
			<button type="button" className="danger manage__small" onClick={onConfirm} disabled={busy}>
				{busy ? "Working…" : `Yes, ${label.toLowerCase()}`}
			</button>
			<button type="button" className="manage__small" onClick={() => setConfirming(null)} disabled={busy}>
				Cancel
			</button>
		</span>
	);
}

/** An error from the server, worded as it said, for a form or a row. */
export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
