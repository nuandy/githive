import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Box, BoxHeader, BoxTitle } from "./ui/box";
import { Field, FieldHint } from "./ui/field";

// What a repo's Settings sections share: a ruled section per part, under its title and a line on what it's for; fields
// a little apart, each with what's wrong with it under it; and the words a save bar says.

/** A section's fields. */
export const SETTINGS_FIELDS = "grid gap-3.5";
/**
 * A command, a path or a repo's name, typed in a field, at the field's own line height (a font size drops the one
 * before it); a long text field adds its own after this.
 */
export const COMMAND = "font-mono text-meta leading-[inherit]";
/** A group of fields in a ruled frame, its legend on the frame (a path rule, a branch rule). */
export const RULE = "m-0 grid min-w-0 gap-2 rounded-md border border-border p-3";
/** A link-like button that takes a rule away. */
export const REMOVE = "justify-self-start text-bad";

/**
 * A part of a repo's Settings: its title, a line on what it's for (saying when what's changed applies at once), then
 * what it holds.
 */
export function SettingsPart({
	id,
	title,
	description,
	children,
	...props
}: Omit<ComponentProps<"section">, "title"> & { id: string; title: ReactNode; description?: ReactNode }) {
	return (
		<Box aria-labelledby={`${id}-title`} {...props}>
			<BoxHeader>
				<BoxTitle id={`${id}-title`}>{title}</BoxTitle>
			</BoxHeader>
			{description ? <p className="mt-3 mb-0 max-w-measure px-0.5 text-muted-foreground">{description}</p> : null}
			{children}
		</Box>
	);
}

/** A heading within a part (Collaborators, under General & access), ruled off from what's above it. */
export function SettingsSubhead({ className, ...props }: ComponentProps<"h3">) {
	return (
		<h3 className={cn("mt-4 border-t border-border px-0.5 pt-4 pb-1 text-body font-semibold", className)} {...props} />
	);
}

/** A field in a settings form: its label, control and hint, close together. */
export function SettingField({ className, ...props }: ComponentProps<"div">) {
	// Its parts keep to the top when a row beside it is taller.
	return <Field className={cn("content-start gap-1", className)} {...props} />;
}

export function SettingHint({ className, ...props }: ComponentProps<"p">) {
	return <FieldHint className={cn("text-meta", className)} {...props} />;
}

/** Something wrong with a form: under which field (its id), and how to put it right. */
export interface FieldProblem {
	field: string;
	text: string;
}

/**
 * A field's problems: whether it has any, the attributes that mark it (aria-invalid, and aria-describedby naming its
 * hint, if it has one, and its problems), and the line to show under it.
 */
export function problemsFor(problems: FieldProblem[], field: string, hint?: string) {
	const texts = [...new Set(problems.filter((problem) => problem.field === field).map((problem) => problem.text))];
	const id = `${field}-problem`;
	const describedBy = [hint, texts.length ? id : null].filter(Boolean).join(" ");
	return {
		attrs: {
			"aria-invalid": texts.length ? true : undefined,
			"aria-describedby": describedBy || undefined,
		},
		line: texts.length ? (
			<p id={id} className="m-0 flex animate-appear items-start gap-1.5 text-ui wrap-anywhere text-bad">
				<Icon name="alert" size={14} className="mt-0.75 shrink-0" />
				<span>{texts.join(" ")}</span>
			</p>
		) : null,
	};
}

/** What the save bar says of a form's problems: the one, or how many there are to put right above. */
export function problemsStatus(problems: FieldProblem[]): ReactNode {
	const texts = [...new Set(problems.map((problem) => problem.text))];
	if (!texts.length) return null;
	return (
		<span className="text-bad">
			{texts.length === 1 ? texts[0] : `${texts.length} things to put right, each marked where it is.`}
		</span>
	);
}

/** What a form's last save said: what it did (in words for the save bar), or why it failed. */
export type Said = { saved: ReactNode } | { failed: string } | null;

/**
 * What a save bar says: what a save did, politely (`status`); why it failed, or the form's problems, at once (`alert`).
 */
export function saveBarSays(said: Said, problems: FieldProblem[] = []): { status?: ReactNode; alert?: ReactNode } {
	if (problems.length) return { alert: problemsStatus(problems) };
	if (!said) return {};
	return "failed" in said ? { alert: failedStatus(said.failed) } : { status: said.saved };
}

/** What a save bar says once saved, or why a save failed. */
export function savedStatus(words: ReactNode) {
	return (
		<span className="inline-flex animate-appear items-start gap-1.5 text-good">
			<Icon name="check" size={14} className="mt-0.75 shrink-0" />
			<span>{words}</span>
		</span>
	);
}
export const failedStatus = (error: string) => <span className="animate-appear text-bad">{error}</span>;
