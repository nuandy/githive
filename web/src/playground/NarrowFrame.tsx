import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

// The playground's narrow view. The Hive tab lays itself out by the window's width (media queries), so a narrow
// container in a wide window wouldn't show its narrow layout. An iframe is a window of its own: the same Hive, from
// the same run, drawn into it by a React root of its own, with the page's styles copied in and kept in step.

const BLANK = "<!doctype html><html><head></head><body></body></html>";

export function NarrowFrame({ width, children }: { width: number; children: ReactNode }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [root, setRoot] = useState<Root | null>(null);
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
			// Nothing sits above the Hive in the frame.
			doc.documentElement.style.setProperty("--topbar-height", "0px");
			const container = doc.createElement("div");
			doc.body.replaceChildren(container);
			// The frame grows with what's in it, so the outer page scrolls rather than the frame.
			const sizes = new ResizeObserver(() => setHeight(Math.ceil(doc.body.getBoundingClientRect().height)));
			sizes.observe(doc.body);
			made = createRoot(container);
			setRoot(made);
			stop = () => {
				styles.disconnect();
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
		root?.render(children);
	}, [root, children]);

	return (
		<iframe
			ref={frame}
			className="playground__frame"
			srcDoc={BLANK}
			title={`The Hive in a window ${width} px wide`}
			style={{ width, height }}
		/>
	);
}
