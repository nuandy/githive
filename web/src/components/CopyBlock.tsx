import { useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

function buttonText(copied: "copied" | "selected" | null, label: string): string {
	if (copied === "copied") return "Copied";
	if (copied === "selected") return "Selected: press ⌘C";
	return label;
}

/** A command or secret to copy: shown in full, with a Copy button that falls back to selecting the text. */
export function CopyBlock({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
	const codeRef = useRef<HTMLElement>(null);
	const [copied, setCopied] = useState<"copied" | "selected" | null>(null);
	const selectText = () => {
		const node = codeRef.current;
		const selection = typeof window !== "undefined" ? window.getSelection() : null;
		if (!node || !selection) return;
		const range = document.createRange();
		range.selectNodeContents(node);
		selection.removeAllRanges();
		selection.addRange(range);
		setCopied("selected");
	};
	const copy = () => {
		// Called inside the click so the browser allows it. If a browser refuses anyway, the text is selected instead.
		try {
			navigator.clipboard.writeText(text).then(() => setCopied("copied"), selectText);
		} catch {
			selectText();
		}
	};
	const shortText = text.length > 40 ? `${text.slice(0, 40)}…` : text;
	return (
		<div className={cn("flex min-w-0 items-start gap-2 to-560:flex-col to-560:items-stretch", className)}>
			<pre className="min-w-0 flex-1 border border-border px-3 py-2.25">
				<code ref={codeRef}>{text}</code>
			</pre>
			<Button className="min-w-18 shrink-0" onClick={copy} aria-label={`${label}: ${shortText}`}>
				{buttonText(copied, label)}
			</Button>
		</div>
	);
}
