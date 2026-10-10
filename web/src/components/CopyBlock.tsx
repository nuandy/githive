import { useRef, useState } from "react";
import "./CopyBlock.css";

function buttonText(copied: "copied" | "selected" | null, label: string): string {
	if (copied === "copied") return "Copied";
	if (copied === "selected") return "Selected: press ⌘C";
	return label;
}

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
		// Called inside the click so the browser allows it. If a browser refuses anyway, the text is selected instead.
		try {
			navigator.clipboard.writeText(text).then(() => setCopied("copied"), selectText);
		} catch {
			selectText();
		}
	};
	const shortText = text.length > 40 ? `${text.slice(0, 40)}…` : text;
	return (
		<div className="copy-block">
			<pre>
				<code ref={codeRef}>{text}</code>
			</pre>
			<button type="button" className="copy-block__button" onClick={copy} aria-label={`${label}: ${shortText}`}>
				{buttonText(copied, label)}
			</button>
		</div>
	);
}
