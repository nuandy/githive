import { type RefObject, useLayoutEffect, useRef } from "react";

/** How long a glide takes, and its easing (the theme's ease-out). */
const GLIDE_MS = 380;
const GLIDE_EASING = "cubic-bezier(0.2, 0.7, 0.3, 1)";

/**
 * Items glide to where they now are when a list changes shape (one arrives, or moves to another section) instead of
 * jumping (FLIP): each element in `container` matching `items` is followed by its `data-key`. Positions are measured
 * within the container, so scrolling moves nothing; and a change that keeps the same `shape` (an item opening, a view
 * changing) is left to the items' own transitions. Reduced motion turns it off.
 */
export function useGlide(container: RefObject<HTMLElement | null>, shape: string, items = "[data-key]") {
	const last = useRef<{ shape: string; tops: Map<string, number> }>({ shape, tops: new Map() });
	useLayoutEffect(() => {
		const element = container.current;
		if (!element) return;
		const origin = element.getBoundingClientRect().top;
		const rows = [...element.querySelectorAll<HTMLElement>(items)];
		const tops = new Map(rows.map((row) => [row.dataset.key ?? "", row.getBoundingClientRect().top - origin]));
		const before = last.current;
		last.current = { shape, tops };
		if (before.shape === shape || !before.tops.size) return;
		if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		for (const row of rows) {
			const was = before.tops.get(row.dataset.key ?? "");
			const is = tops.get(row.dataset.key ?? "");
			if (was === undefined || is === undefined || Math.abs(was - is) < 2) continue;
			row.animate([{ transform: `translateY(${was - is}px)` }, { transform: "none" }], {
				duration: GLIDE_MS,
				easing: GLIDE_EASING,
			});
		}
	});
}
