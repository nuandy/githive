import { afterEach, describe, expect, it, vi } from "vitest";
import { motionMs, reducedMotion } from "./motion";

const prefers = (reduce: boolean) =>
	vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduced-motion") }));

describe("JavaScript motion", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("waits as long as a motion takes", () => {
		prefers(false);
		expect(reducedMotion()).toBe(false);
		expect(motionMs(400)).toBe(400);
	});

	it("waits for nothing under reduced motion, where nothing moves", () => {
		prefers(true);
		expect(reducedMotion()).toBe(true);
		expect(motionMs(400)).toBe(0);
	});

	it("moves as usual where there's no window to ask", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(reducedMotion()).toBe(false);
		expect(motionMs(250)).toBe(250);
	});
});
