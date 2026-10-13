import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PortalContainer } from "../components/ui/tooltip";

// The playground's narrow view. The Hive tab lays itself out by the window's width (media queries), so a narrow
// container in a wide window wouldn't show its narrow layout. An iframe is a window of its own: the same Hive, from
// the same run, drawn into it by a React root of its own, with the page's styles and its light or dark copied in and
// kept in step. Its tooltips and popovers open in it too.

const BLANK = "<!doctype html><html><head></head><body></body></html>";

export function NarrowFrame({ width, children }: { width: number; children: ReactNode }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [root, setRoot] = useState<Root | null>(null);
	// The frame's own body, where its tooltips and popovers go.
	const [body, setBody] = useState<HTMLElement | null>(null);
	const [height, setHeight] = useState(800);

	useEffect(() => {
		const iframe = frame.current;
		if (!iframe) return;
		let made: Root | undefined;
		let stop = () => {};
		const setUp = () => {
			const doc = iframe.contentDocument;
			const win = iframe.contentWindow;
			if (made || !doc || !win || doc.URL !== "about:srcdoc") return;
			// Vite adds and rewrites the page's <style> tags as modules load and change; the frame follows them.
			const copyStyles = () =>
				doc.head.replaceChildren(
					...Array.from(document.head.querySelectorAll("style, link[rel='stylesheet']"), (node) =>
						node.cloneNode(true),
					),
				);
			copyStyles();
			const styles = new MutationObserver(copyStyles);
			styles.observe(document.head, { childList: true, subtree: true, characterData: true });
			// Light or dark, as the page is: its <html> carries the theme (lib/theme.ts).
			const copyTheme = () => {
				doc.documentElement.classList.toggle("dark", document.documentElement.classList.contains("dark"));
				const chosen = document.documentElement.dataset.theme;
				if (chosen) doc.documentElement.dataset.theme = chosen;
				else delete doc.documentElement.dataset.theme;
			};
			copyTheme();
			const theme = new MutationObserver(copyTheme);
			theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
			// Nothing sits above the Hive in the frame.
			doc.documentElement.style.setProperty("--topbar-height", "0px");
			const container = doc.createElement("div");
			doc.body.replaceChildren(container);
			// The frame grows with what's in it, so the outer page scrolls rather than the frame.
			const sizes = new ResizeObserver(() => setHeight(Math.ceil(doc.body.getBoundingClientRect().height)));
			sizes.observe(doc.body);
			made = createRoot(container);
			setBody(doc.body);
			setRoot(made);
			stop = () => {
				styles.disconnect();
				theme.disconnect();
				sizes.disconnect();
			};
		};
		iframe.addEventListener("load", setUp);
		if (iframe.contentDocument?.readyState === "complete") setUp();
		return () => {
			iframe.removeEventListener("load", setUp);
			stop();
			const unmount = made;
			// A root can't be unmounted while React is committing another; let this commit finish first.
			if (unmount) setTimeout(() => unmount.unmount());
			setRoot(null);
		};
	}, []);

	useEffect(() => {
		root?.render(<PortalContainer value={body}>{children}</PortalContainer>);
	}, [root, body, children]);

	return (
		<iframe
			ref={frame}
			className="mx-auto block max-w-full rounded-md border border-border bg-background"
			srcDoc={BLANK}
			title={`The Hive in a window ${width} px wide`}
			style={{ width, height }}
		/>
	);
}
