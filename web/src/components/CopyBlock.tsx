import { useEffect, useRef, useState } from "react";
import { useChanged } from "../hooks/useChanged";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

type Copied = "copied" | "selected" | null;

function buttonText(copied: Copied, label: string): string {
	if (copied === "copied") return "Copied";
	if (copied === "selected") return "Selected: press ⌘C";
	return label;
}

/**
 * The text with each flag (--transport, -m) kept whole: browsers break a line after a hyphen, which would leave "--"
 * at one line's end and "transport" at the next's. A line breaks at a space instead.
 */
function WholeFlags({ text }: { text: string }) {
	return (
		<>
			{text.split(/(\s+)/).map((part, index) =>
				index % 2 === 0 && /^-[^\s]{1,40}$/.test(part) ? (
					<span key={index} className="whitespace-nowrap">
						{part}
					</span>
				) : (
					part
				),
			)}
		</>
	);
}

/**
 * A command or secret to copy: shown in full, with a Copy button that falls back to selecting the text. The button is
 * named by what it copies, never by the text, which may be a secret; a status line says it's copied, for a while.
 */
export function CopyBlock({
	text,
	label = "Copy",
	className,
	onCopy,
}: {
	text: string;
	label?: string;
	className?: string;
	/** Called once it's copied, or selected for the reader to copy. */
	onCopy?: () => void;
}) {
	const codeRef = useRef<HTMLElement>(null);
	const [copied, setCopied] = useState<Copied>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const show = (state: Copied) => {
		setCopied(state);
		onCopy?.();
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(null), 2000);
	};
	// The button's words cross-fade as they change; as the page first shows, they come with it.
	const changed = useChanged(copied);
	const selectText = () => {
		const node = codeRef.current;
		const selection = typeof window !== "undefined" ? window.getSelection() : null;
		if (!node || !selection) return;
		const range = document.createRange();
		range.selectNodeContents(node);
		selection.removeAllRanges();
		selection.addRange(range);
		show("selected");
	};
	const copy = () => {
		// Called inside the click so the browser allows it. If a browser refuses anyway, the text is selected instead.
		try {
			navigator.clipboard.writeText(text).then(() => show("copied"), selectText);
		} catch {
			selectText();
		}
	};
	return (
		<div className={cn("flex min-w-0 items-start gap-2 to-560:flex-col to-560:items-stretch", className)}>
			<pre className="min-w-0 flex-1 border border-border px-3 py-2.25">
				<code ref={codeRef}>
					<WholeFlags text={text} />
				</code>
			</pre>
			<Button className="min-w-18 shrink-0" onClick={copy}>
				<span key={copied ?? "label"} className={cn(changed && "animate-fade")}>
					{buttonText(copied, label)}
				</span>
			</Button>
			<span role="status" className="sr-only">
				{copied ? buttonText(copied, label) : null}
			</span>
		</div>
	);
}
