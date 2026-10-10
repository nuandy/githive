import { useRef, useState } from "react";
import "./CopyBlock.css";

/** A command or secret to copy: shown in full, with a Copy button that falls back to selecting the text. */
export function CopyBlock({ text, label = "Copy" }: { text: string; label?: string }) {
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
		// Called inside the click, so the browser allows it; some refuse anyway, and then the text is selected to copy by hand.
		try {
			navigator.clipboard.writeText(text).then(() => setCopied("copied"), selectText);
		} catch {
			selectText();
		}
	};
	return (
		<div className="copy-block">
			<pre>
				<code ref={codeRef}>{text}</code>
			</pre>
			<button
				type="button"
				className="copy-block__button"
				onClick={copy}
				aria-label={`${label}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`}
			>
				{copied === "copied" ? "Copied" : copied === "selected" ? "Selected: press ⌘C" : label}
			</button>
		</div>
	);
}
