import { useEffect, useRef, type KeyboardEvent } from "react";
import { Button } from "./ui/button";

/**
 * A destructive action asked twice, in the page (never confirm()): the first
 * click asks the question, the second does it. One question is open at a
 * time; `confirming` says which. The question fades in where the button was,
 * with focus on Cancel; Cancel or Escape puts the button, and focus, back.
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
	const asking = confirming === id;
	const trigger = useRef<HTMLButtonElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	// Whether the question was just answered no: only then does focus go back to the button. Answered yes, or closed
	// by another question opening, focus is left to what follows.
	const declined = useRef(false);
	useEffect(() => {
		if (asking) cancel.current?.focus();
		else if (declined.current) trigger.current?.focus();
		declined.current = false;
	}, [asking]);

	const decline = () => {
		declined.current = true;
		setConfirming(null);
	};
	const escape = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || busy) return;
		event.stopPropagation();
		decline();
	};

	if (!asking)
		return (
			<Button ref={trigger} variant="danger" size="sm" onClick={() => setConfirming(id)} disabled={busy}>
				{label}
			</Button>
		);
	return (
		<span
			className="inline-flex animate-appear flex-wrap items-center gap-1.5 text-ui"
			role="group"
			aria-label={question}
			onKeyDown={escape}
		>
			<span>{question}</span>
			<Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
				{busy ? "Working…" : `Yes, ${label.toLowerCase()}`}
			</Button>
			<Button ref={cancel} size="sm" onClick={decline} disabled={busy}>
				Cancel
			</Button>
		</span>
	);
}
