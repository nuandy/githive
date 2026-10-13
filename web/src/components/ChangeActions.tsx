import { type ReactNode, useRef, useState } from "react";
import type { ReleaseAnswer } from "../api";
import { messageOf, reasonOf, sentence } from "../lib/errors";
import { type Batch, batchWords } from "../lib/decision";
import { shortSha } from "../lib/model";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Field, FieldHint, Label, Textarea } from "./ui/field";

// What a person does to a change from its decision box: land it now, after a confirm that names what lands with it
// and what runs first; or release its claim, saying why. Each says what came of it in a line that keeps its name.

/** What came of an action, in a line: "Landed as 1a2b3c4.", or why it couldn't. */
export interface Outcome {
	ok: boolean;
	text: string;
}

export function OutcomeLine({ outcome, className }: { outcome: Outcome | null; className?: string }) {
	if (!outcome) return null;
	return (
		<p
			key={outcome.text}
			className={cn("m-0 animate-appear text-ui wrap-anywhere", outcome.ok ? "text-good" : "text-bad", className)}
			role="status"
		>
			{outcome.text}
		</p>
	);
}

export type MergeAnswer = { ok: boolean; commit?: string; reasons?: string[]; conflicts?: string[] };

/** Why a change couldn't land, when the call failed: the server's words, as they came, in a sentence. */
export const landFailure = (err: unknown): Outcome => ({
	ok: false,
	text: sentence(`It couldn't land: ${reasonOf(err)}`),
});

/**
 * Land now, for a person who can write, once the change can land: a confirm names the changes that land with it and
 * the checks that run first, then it lands as its agent would (the same batch, checked first), stamped with their
 * name. Once it has landed it can't be pressed again, and the page reads the change afresh.
 */
export function LandNow({
	change,
	batch,
	checks,
	land,
	onOutcome,
	onSettled,
}: {
	change: string;
	/** The other ready changes that land with it. */
	batch: Batch;
	/** The checks that run first. */
	checks: string[];
	land: () => Promise<MergeAnswer>;
	onOutcome: (outcome: Outcome) => void;
	/**
	 * Once it has landed, the button goes with the change's claim: focus on it, or in its confirm, goes where this puts
	 * it first.
	 */
	onSettled?: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const landedNow = useRef(false);
	const button = useRef<HTMLButtonElement>(null);
	// Nothing is disabled while it lands, so focus stays on the button: it's busy, and a press does nothing.
	const idle = !busy && !done;
	const settle = () => {
		const active = document.activeElement;
		if (!active || active === document.body || active === button.current) onSettled?.();
	};
	const go = async () => {
		setBusy(true);
		try {
			const landed = await land();
			if (landed.ok) {
				landedNow.current = true;
				setDone(true);
			}
			onOutcome(
				landed.ok
					? { ok: true, text: `Landed as ${shortSha(landed.commit)}.` }
					: { ok: false, text: `It couldn't land: ${(landed.reasons ?? ["no reason was given"]).join(" ")}` },
			);
			if (landed.ok) settle();
		} catch (err) {
			onOutcome(landFailure(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					ref={button}
					variant="go"
					className="w-full"
					aria-disabled={idle ? undefined : true}
					onClick={(event) => {
						if (!idle) event.preventDefault();
					}}
				>
					{busy ? <Icon name="loader" /> : <Icon name={done ? "check" : "merge"} />}
					{busy ? "Landing… its checks run first" : done ? "Landed" : "Land now"}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent
				onCloseAutoFocus={(event) => {
					if (!landedNow.current) return;
					event.preventDefault();
					onSettled?.();
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Land {change} now?</AlertDialogTitle>
					<AlertDialogDescription>
						{batchWords(batch)}
						{checks.length ? ", after " : ", with no checks to run."}
						{checks.length ? <Checks checks={checks} /> : null}
					</AlertDialogDescription>
					<p className="m-0 text-ui text-muted-foreground">
						If any check fails, nothing lands, and the change goes back to its agent.
					</p>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="go" onClick={() => void go()}>
						Land now
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** "`npm ci`, `npm test` and `npm run e2e`." */
function Checks({ checks }: { checks: string[] }) {
	return (
		<>
			{checks.map((check, index) => (
				<span key={check}>
					{index === 0 ? null : index === checks.length - 1 ? " and " : ", "}
					<code>{check}</code>
				</span>
			))}
			.
		</>
	);
}

/** What releasing a change's claim does, said before and after. */
export const RELEASE_CONSEQUENCE =
	"Its paths are free for other agents; its agent is told; its commits stay on its branch.";
const GITHUB_CONSEQUENCE =
	"Its paths are free; GitHive brings GitHub's changes back when GitHub's branch moves, or when someone asks.";

/**
 * Release a change's claim, for a person who can write: whoever's it is, saying why, which its agent is told. A
 * question to answer first, over the page: its consequence, a reason, then Release or Cancel.
 */
export function ReleaseDialog({
	change,
	github = false,
	open,
	onOpenChange,
	release,
	onOutcome,
	onCloseAutoFocus,
	children,
}: {
	change: string;
	/** GitHub's change, given up until GitHub's branch moves. */
	github?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	release: (reason: string) => Promise<ReleaseAnswer>;
	onOutcome: (outcome: Outcome) => void;
	/** Where focus goes as it closes, and whether the claim was released (what opened it may be going with it). */
	onCloseAutoFocus?: (event: Event, released: boolean) => void;
	/** Its trigger, when it opens from a button of its own. */
	children?: ReactNode;
}) {
	const released = useRef(false);
	const [own, setOwn] = useState(false);
	const shown = open ?? own;
	const show = onOpenChange ?? setOwn;
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const consequence = github ? GITHUB_CONSEQUENCE : RELEASE_CONSEQUENCE;
	const go = async () => {
		if (!reason.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const answer = await release(reason.trim());
			if (!answer.ok) {
				setError(answer.refused ?? "It couldn't be released.");
				return;
			}
			released.current = true;
			show(false);
			setReason("");
			onOutcome({ ok: true, text: `Released. ${answer.note ?? consequence}` });
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<AlertDialog open={shown} onOpenChange={show}>
			{children ? <AlertDialogTrigger asChild>{children}</AlertDialogTrigger> : null}
			<AlertDialogContent onCloseAutoFocus={(event) => onCloseAutoFocus?.(event, released.current)}>
				<form
					className="grid gap-4"
					// While it's sent, nothing is disabled, so focus stays where it was: the reason is read-only, and a second
					// press does nothing.
					aria-busy={busy || undefined}
					onSubmit={(event) => {
						event.preventDefault();
						void go();
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>Release {change}’s claim?</AlertDialogTitle>
						<AlertDialogDescription>{consequence}</AlertDialogDescription>
					</AlertDialogHeader>
					<Field>
						<Label htmlFor="release-reason">Why</Label>
						<Textarea
							id="release-reason"
							rows={3}
							required
							maxLength={500}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="What it's stuck on, for its agent and the audit"
							readOnly={busy}
						/>
						{error ? (
							<FieldHint className="text-bad" role="alert">
								{error}
							</FieldHint>
						) : (
							<FieldHint>Its agent is told this, and the release is recorded with your name.</FieldHint>
						)}
					</Field>
					<AlertDialogFooter>
						<AlertDialogCancel type="button">Cancel</AlertDialogCancel>
						<Button type="submit" variant="danger" disabled={!reason.trim()} aria-disabled={busy || undefined}>
							{busy ? "Releasing…" : "Release claim"}
						</Button>
					</AlertDialogFooter>
				</form>
			</AlertDialogContent>
		</AlertDialog>
	);
}
