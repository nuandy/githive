import { useEffect, useRef, type KeyboardEvent } from "react";
import { Button, type ButtonProps } from "./ui/button";

/**
 * A destructive action asked twice, in the page (never confirm()): the first
 * click asks the question, the second does it. One question is open at a
 * time; `confirming` says which. The question fades in where the button was,
 * with focus on the button that keeps things as they are; it, or Escape, puts
 * the button, and focus, back.
 */
export function ConfirmButton({
	id,
	confirming,
	setConfirming,
	label,
	question,
	keep = "Cancel",
	busy,
	onConfirm,
}: {
	id: string;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	label: string;
	/** The question, naming what doing it changes: "Delete @acme/payments? Roles granted to it stop counting…". */
	question: string;
	/** The button that says no, by what it keeps ("Keep invitation"), so it never reads "Cancel" beside "Yes, cancel…". */
	keep?: string;
	busy: boolean;
	onConfirm: () => void;
}) {
	const asking = confirming === id;
	const trigger = useRef<HTMLButtonElement>(null);
	// Whether the question was just answered no: only then does focus go back to the button. Answered yes, or closed
	// by another question opening, focus is left to what follows.
	const declined = useRef(false);
	useEffect(() => {
		if (!asking && declined.current) trigger.current?.focus();
		declined.current = false;
	}, [asking]);

	if (!asking)
		return (
			<Button ref={trigger} variant="danger" size="sm" onClick={() => setConfirming(id)} disabled={busy}>
				{label}
			</Button>
		);
	return (
		<Question
			question={question}
			yes={`Yes, ${label.toLowerCase()}`}
			keep={keep}
			busy={busy}
			onYes={onConfirm}
			onKeep={() => {
				declined.current = true;
				setConfirming(null);
			}}
		/>
	);
}

/**
 * A question asked in the page, in place of what asked it: what it changes, Yes, and the button that keeps things as
 * they are, which has focus as it appears. Escape answers no.
 */
export function Question({
	question,
	yes,
	keep,
	yesVariant = "danger",
	busy,
	onYes,
	onKeep,
}: {
	question: string;
	/** Going ahead: "Yes, " and what it does. */
	yes: string;
	keep: string;
	/** Red ink for what takes something away; ink for what gives more. */
	yesVariant?: ButtonProps["variant"];
	busy: boolean;
	onYes: () => void;
	onKeep: () => void;
}) {
	const kept = useRef<HTMLButtonElement>(null);
	useEffect(() => kept.current?.focus(), []);
	const escape = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || busy) return;
		event.stopPropagation();
		onKeep();
	};
	return (
		<span
			className="inline-flex animate-appear flex-wrap items-center gap-1.5 text-ui"
			role="group"
			aria-label={question}
			onKeyDown={escape}
		>
			<span>{question}</span>
			<Button variant={yesVariant} size="sm" onClick={onYes} disabled={busy}>
				{busy ? "Working…" : yes}
			</Button>
			<Button ref={kept} size="sm" onClick={onKeep} disabled={busy}>
				{keep}
			</Button>
		</span>
	);
}
