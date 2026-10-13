import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useReturnFocus } from "../hooks/useReturnFocus";
import { filterPalette, type PaletteItem, paletteItems } from "../lib/palette";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

// What the keyboard can do beyond Tab: a palette (⌘K or Ctrl-K) that jumps to a repo, an open change or a page, and
// the list of shortcuts (?). DashboardKeys listens for the keys, and loads these as they're first opened.

const KIND: Record<PaletteItem["kind"], { icon: IconName; word: string }> = {
	change: { icon: "pull", word: "Change" },
	repo: { icon: "repo", word: "Repository" },
	page: { icon: "arrow", word: "Page" },
};

/** A key, as it's printed on the keyboard. */
export function Kbd({ children }: { children: string }) {
	return (
		<kbd className="inline-block min-w-5.5 rounded-sm border border-border-strong bg-surface-2 px-1.5 text-center font-mono text-caption leading-5 text-foreground">
			{children}
		</kbd>
	);
}

/**
 * The palette: a field, and the places that answer what's typed in it. Arrow keys move through them, Enter goes,
 * Escape closes; a screen reader hears the one chosen (a combobox and its listbox) and how many there are.
 */
export function CommandPalette({
	open,
	onOpenChange,
	places,
	go = (to) => {
		window.location.hash = to;
	},
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** What it offers: the reader's repos, the repo shown and its open changes, and which pages are theirs. */
	places: Parameters<typeof paletteItems>[0];
	/** Goes to a place's address (tests watch it). */
	go?: (href: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const went = useRef(false);
	const list = useRef<HTMLUListElement>(null);
	const id = useId();
	const shown = filterPalette(open ? paletteItems(places) : [], query);
	const chosen = Math.min(active, Math.max(shown.length - 1, 0));
	// It has no trigger: closed, focus goes back to what had it.
	const returnFocus = useReturnFocus(open);
	// Each time it opens, it starts afresh.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActive(0);
		went.current = false;
	}, [open]);
	useEffect(() => {
		list.current?.querySelector(`[data-index="${chosen}"]`)?.scrollIntoView({ block: "nearest" });
	}, [chosen]);
	const choose = (item: PaletteItem | undefined) => {
		if (!item) return;
		// To the page it's on, nothing moves: focus goes back.
		went.current = window.location.hash !== item.href;
		onOpenChange(false);
		go(item.href);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		if (step && shown.length) {
			event.preventDefault();
			setActive((chosen + step + shown.length) % shown.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			choose(shown[chosen]);
		}
	};
	const optionId = (index: number) => `${id}-option-${index}`;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				closable={false}
				aria-describedby={undefined}
				// ⌘K opens no palette over another dialog, but closes this one (useShortcuts).
				data-palette=""
				className="top-[12vh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
				// Going somewhere, focus goes to the new page's heading; else back to what had it.
				onCloseAutoFocus={(event) => {
					if (went.current) event.preventDefault();
					else returnFocus(event);
				}}
			>
				<DialogTitle className="sr-only">Go to</DialogTitle>
				<div className="flex items-center gap-2.5 border-b border-border px-4">
					<Icon name="search" className="shrink-0 text-muted-foreground" />
					<input
						className="h-12 min-w-0 flex-1 border-0 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
						placeholder="Go to a repository, a change or a page…"
						role="combobox"
						aria-label="Go to"
						aria-expanded={shown.length > 0}
						aria-controls={`${id}-list`}
						aria-autocomplete="list"
						aria-activedescendant={shown.length ? optionId(chosen) : undefined}
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
						onKeyDown={onKeyDown}
					/>
					<Kbd>Esc</Kbd>
				</div>
				<ul
					ref={list}
					id={`${id}-list`}
					role="listbox"
					aria-label="Places"
					className="m-0 max-h-[min(60vh,26rem)] list-none overflow-y-auto p-1.5"
				>
					{shown.map((item, index) => (
						<li
							key={item.id}
							id={optionId(index)}
							data-index={index}
							role="option"
							aria-selected={index === chosen}
							className={cn(
								"flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-ui-lg",
								index === chosen && "bg-link-soft text-link",
							)}
							onMouseMove={() => setActive(index)}
							onClick={() => choose(item)}
						>
							<Icon name={KIND[item.kind].icon} className="shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate">{item.label}</span>
							{item.detail ? (
								<span className="shrink-0 font-mono text-caption text-muted-foreground to-560:hidden">
									{item.detail}
								</span>
							) : null}
							<span className="shrink-0 text-caption text-muted-foreground">{KIND[item.kind].word}</span>
						</li>
					))}
				</ul>
				{shown.length ? null : <p className="m-0 px-4 pt-1 pb-4 text-muted-foreground">Nothing matches “{query}”.</p>}
				<p className="sr-only" aria-live="polite">
					{shown.length === 1 ? "1 place" : `${shown.length} places`}
				</p>
				<p className="m-0 flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-caption text-muted-foreground">
					<span>
						<Kbd>↑</Kbd> <Kbd>↓</Kbd> to choose
					</span>
					<span>
						<Kbd>Enter</Kbd> to go
					</span>
				</p>
			</DialogContent>
		</Dialog>
	);
}

/** The shortcuts, in the order the list shows them. */
export const SHORTCUTS: { keys: string[][]; what: string }[] = [
	{ keys: [["g", "i"]], what: "Go to the Inbox" },
	{ keys: [["g", "r"]], what: "Go to Repositories" },
	{ keys: [["/"]], what: "Find a repository, on Repositories" },
	{ keys: [["1"], ["8"]], what: "Choose one of a repo's tabs, 1 for the Hive to 8 for Settings" },
	{
		keys: [
			["⌘", "K"],
			["Ctrl", "K"],
		],
		what: "Jump to a repository, an open change in this repo, or a page",
	},
	{ keys: [["?"]], what: "Show these shortcuts" },
];

/** The list of shortcuts, in a dialog. Closed, focus goes back to what had it: a key opened it, or the user menu. */
export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const returnFocus = useReturnFocus(open);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent onCloseAutoFocus={returnFocus}>
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>Anywhere but in a field you're typing in.</DialogDescription>
				</DialogHeader>
				<dl className="m-0 grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2.5">
					{SHORTCUTS.map((shortcut) => (
						<div key={shortcut.what} className="contents">
							<dt className="flex flex-wrap items-center gap-1 whitespace-nowrap">
								{shortcut.keys.map((combo, index) => (
									<span key={combo.join("+")} className="inline-flex items-center gap-1">
										{index > 0 ? (
											<span className="text-caption text-muted-foreground">
												{shortcut.keys.length === 2 && combo[0] === "8" ? "to" : "or"}
											</span>
										) : null}
										{combo.map((key, at) => (
											<span key={key} className="inline-flex items-center gap-1">
												{at > 0 && combo[0] === "g" ? (
													<span className="text-caption text-muted-foreground">then</span>
												) : null}
												<Kbd>{key}</Kbd>
											</span>
										))}
									</span>
								))}
							</dt>
							<dd className="m-0 text-ui-lg">{shortcut.what}</dd>
						</div>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}
