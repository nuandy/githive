import { type ReactNode, useState } from "react";
import type { ReleaseAnswer } from "../api";
import { messageOf } from "../lib/errors";
import { listed } from "../lib/decision";
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

/**
 * Land now, for a person who can write, once the change can land: a confirm names the changes that land with it and
 * the checks that run first, then it lands as its agent would (the same batch, checked first), stamped with their
 * name.
 */
export function LandNow({
	change,
	batch,
	checks,
	land,
	onOutcome,
}: {
	change: string;
	/** The other ready changes that land with it. */
	batch: string[];
	/** The checks that run first. */
	checks: string[];
	land: () => Promise<MergeAnswer>;
	onOutcome: (outcome: Outcome) => void;
}) {
	const [busy, setBusy] = useState(false);
	const go = async () => {
		setBusy(true);
		try {
			const landed = await land();
			onOutcome(
				landed.ok
					? { ok: true, text: `Landed as ${shortSha(landed.commit)}.` }
					: { ok: false, text: `It couldn't land: ${(landed.reasons ?? ["no reason was given"]).join(" ")}` },
			);
		} catch (err) {
			onOutcome({ ok: false, text: `It couldn't land: ${messageOf(err)}` });
		} finally {
			setBusy(false);
		}
	};
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button variant="go" className="w-full" disabled={busy}>
					{busy ? <Icon name="loader" /> : <Icon name="merge" />}
					{busy ? "Landing… its checks run first" : "Land now"}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Land {change} now?</AlertDialogTitle>
					<AlertDialogDescription>
						{batch.length ? (
							<>
								It lands with {listed(batch)}
								{checks.length ? ", after " : ", with no checks to run."}
							</>
						) : (
							<>It lands on its own{checks.length ? ", after " : ", with no checks to run."}</>
						)}
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
	children,
}: {
	change: string;
	/** GitHub's change, given up until GitHub's branch moves. */
	github?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	release: (reason: string) => Promise<ReleaseAnswer>;
	onOutcome: (outcome: Outcome) => void;
	/** Its trigger, when it opens from a button of its own. */
	children?: ReactNode;
}) {
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
			<AlertDialogContent>
				<form
					className="grid gap-4"
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
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="What it's stuck on, for its agent and the audit"
							disabled={busy}
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
						<Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
							{busy ? "Releasing…" : "Release claim"}
						</Button>
					</AlertDialogFooter>
				</form>
			</AlertDialogContent>
		</AlertDialog>
	);
}
