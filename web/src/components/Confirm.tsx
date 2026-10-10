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
	block = "manage",
}: {
	id: string;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	label: string;
	question: string;
	busy: boolean;
	onConfirm: () => void;
	/** The CSS block its classes belong to: manage__small and manage__confirm by default. */
	block?: string;
}) {
	if (confirming !== id)
		return (
			<button type="button" className={`danger ${block}__small`} onClick={() => setConfirming(id)} disabled={busy}>
				{label}
			</button>
		);
	return (
		<span className={`${block}__confirm`} role="group" aria-label={question}>
			<span>{question}</span>
			<button type="button" className={`danger ${block}__small`} onClick={onConfirm} disabled={busy}>
				{busy ? "Working…" : `Yes, ${label.toLowerCase()}`}
			</button>
			<button type="button" className={`${block}__small`} onClick={() => setConfirming(null)} disabled={busy}>
				Cancel
			</button>
		</span>
	);
}
