import { Button } from "./ui/button";

/**
 * A destructive action asked twice, in the page (never confirm()): the first
 * click asks the question, the second does it. One question is open at a
 * time; `confirming` says which. The question fades in where the button was.
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
			<Button variant="danger" size="sm" onClick={() => setConfirming(id)} disabled={busy}>
				{label}
			</Button>
		);
	return (
		<span
			className="inline-flex animate-appear flex-wrap items-center gap-1.5 text-ui"
			role="group"
			aria-label={question}
		>
			<span>{question}</span>
			<Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
				{busy ? "Working…" : `Yes, ${label.toLowerCase()}`}
			</Button>
			<Button size="sm" onClick={() => setConfirming(null)} disabled={busy}>
				Cancel
			</Button>
		</span>
	);
}
