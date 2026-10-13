import { type KeyboardEvent, useId, useRef, useState } from "react";
import { addTyped, suggest, type TokenOption } from "../../lib/tokens";
import { cn } from "../../lib/utils";
import { Icon } from "../Icon";

// A list chosen as tokens, in a field's box: each chosen value a chip with a ×, then a text field that offers what
// matches as you type (a combobox and its listbox). Enter or a comma adds what's typed, or the option lit; Backspace in
// an empty field takes the last chip back; Escape closes the list. What's chosen is a list of strings: the token input
// only chooses them, so the form saves the very strings it would have had typed.

export function TokenInput({
	id,
	value,
	onChange,
	options = [],
	labelOf = (token) => token,
	problemOf,
	resolve,
	placeholder,
	disabled = false,
	className,
	"aria-invalid": invalid,
	"aria-describedby": describedBy,
}: {
	/** The text field's id, for its label. */
	id: string;
	value: string[];
	onChange(next: string[]): void;
	/** What to offer as one types. */
	options?: TokenOption[];
	/** A chosen value in words. */
	labelOf?(token: string): string;
	/** What's wrong with a chosen value, or null: its chip is marked. */
	problemOf?(token: string): string | null;
	/** What a typed value saves as (a preset's words stand for its value). */
	resolve?(typed: string): string;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	"aria-invalid"?: boolean;
	"aria-describedby"?: string;
}) {
	const [typed, setTyped] = useState("");
	const [open, setOpen] = useState(false);
	// The option lit by typing or the arrows: none until then, so Enter in an untouched field still submits the form.
	const [active, setActive] = useState(-1);
	const input = useRef<HTMLInputElement>(null);
	const listId = `${useId()}-options`;
	const shown = open ? suggest(options, typed, value) : [];
	const lit = active >= 0 ? shown[Math.min(active, shown.length - 1)] : undefined;

	const add = (text: string) => {
		const next = addTyped(value, text, resolve);
		if (next.length !== value.length) onChange(next);
		setTyped("");
		setActive(-1);
	};
	const remove = (token: string) => {
		onChange(value.filter((chosen) => chosen !== token));
		input.current?.focus();
	};
	const type = (text: string) => {
		setOpen(true);
		setActive(text.trim() ? 0 : -1);
		// A comma ends what came before it.
		const cut = text.lastIndexOf(",");
		if (cut === -1) return setTyped(text);
		add(text.slice(0, cut));
		setTyped(text.slice(cut + 1).trimStart());
	};
	const key = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setOpen(true);
			const count = open ? shown.length : suggest(options, typed, value).length;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((current) => {
				if (!count) return -1;
				if (current < 0) return step > 0 ? 0 : count - 1;
				return (current + step + count) % count;
			});
		} else if (event.key === "Enter") {
			// With nothing typed or lit, Enter submits the form as in any field.
			if (open && lit) {
				event.preventDefault();
				add(lit.value);
			} else if (typed.trim()) {
				event.preventDefault();
				add(typed);
			}
		} else if (event.key === "Escape" && open && shown.length) {
			event.stopPropagation();
			setOpen(false);
		} else if (event.key === "Backspace" && !typed && value.length) {
			onChange(value.slice(0, -1));
		}
	};

	return (
		<div
			data-slot="token-input"
			className={cn(
				"relative flex min-h-9.5 min-w-0 cursor-text flex-wrap items-center gap-1 rounded-md border border-input bg-card px-1.5 py-1",
				"transition-[border-color] duration-fast ease-out",
				"has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
				invalid && "border-bad",
				disabled && "cursor-not-allowed opacity-55",
				className,
			)}
			onMouseDown={(event) => {
				// A click on the box, not on a chip's ×, goes to the text field.
				if (event.target === event.currentTarget) {
					event.preventDefault();
					input.current?.focus();
				}
			}}
		>
			{value.map((token) => {
				const problem = problemOf?.(token) ?? null;
				const label = labelOf(token);
				return (
					<span
						key={token}
						data-slot="token"
						className={cn(
							"inline-flex max-w-full items-center gap-0.5 rounded-sm border py-px pr-0.5 pl-2 text-ui",
							problem ? "border-bad bg-bad-soft text-bad" : "border-border bg-surface-2",
						)}
					>
						{problem ? <Icon name="alert" size={14} className="mr-0.5 shrink-0" /> : null}
						<span className="min-w-0 wrap-anywhere">{label}</span>
						{label !== token ? <span className="sr-only"> ({token})</span> : null}
						{problem ? <span className="sr-only">: {problem}</span> : null}
						<button
							type="button"
							className="touch-target inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-xs text-muted-foreground transition-colors duration-fast hover:bg-surface-3 hover:text-foreground"
							aria-label={`Remove ${label}`}
							disabled={disabled}
							onClick={() => remove(token)}
						>
							<Icon name="x" size={14} />
						</button>
					</span>
				);
			})}
			<input
				ref={input}
				id={id}
				role="combobox"
				aria-expanded={shown.length > 0}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={lit ? `${listId}-${shown.indexOf(lit)}` : undefined}
				aria-invalid={invalid || undefined}
				aria-describedby={describedBy}
				className="min-w-16 flex-1 border-0 bg-transparent px-1 py-0.5 text-foreground outline-none placeholder:text-muted-foreground"
				value={typed}
				placeholder={value.length ? undefined : placeholder}
				autoComplete="off"
				spellCheck={false}
				disabled={disabled}
				onChange={(event) => type(event.target.value)}
				onKeyDown={key}
				onClick={() => setOpen(true)}
				onBlur={() => {
					if (typed.trim()) add(typed);
					setOpen(false);
				}}
			/>
			<ul
				id={listId}
				role="listbox"
				aria-label="Suggestions"
				className={cn(
					"absolute top-full left-0 z-50 mt-1 max-h-64 w-full min-w-56 overflow-auto rounded-md border border-border",
					"m-0 list-none bg-popover p-1 text-ui text-popover-foreground shadow-raised",
					"animate-in fade-in-0",
					!shown.length && "hidden",
				)}
			>
				{shown.map((option, index) => (
					<li
						key={option.value}
						id={`${listId}-${index}`}
						role="option"
						aria-selected={option === lit}
						className={cn(
							"grid cursor-pointer gap-px rounded-sm px-2 py-1.5",
							option === lit && "bg-link-soft text-link",
						)}
						// Chosen before the field loses focus, so the blur doesn't take what's typed instead.
						onMouseDown={(event) => {
							event.preventDefault();
							add(option.value);
						}}
						onMouseEnter={() => setActive(index)}
					>
						<span className="font-semibold">{option.label}</span>
						{option.detail ? (
							<span className={cn("text-caption", option === lit ? "text-link" : "text-muted-foreground")}>
								{option.detail}
							</span>
						) : null}
					</li>
				))}
			</ul>
		</div>
	);
}
