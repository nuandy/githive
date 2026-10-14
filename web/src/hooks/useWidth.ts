import { useEffect, useState } from "react";

/** An element's width as it's drawn, once known: a ref to give the element, and its width in px. */
export function useWidth<T extends Element>(): [(element: T | null) => void, number | undefined] {
	const [element, setElement] = useState<T | null>(null);
	const [width, setWidth] = useState<number>();
	useEffect(() => {
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width));
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return [setElement, width];
}
