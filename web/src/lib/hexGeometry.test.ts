import { describe, expect, it } from "vitest";
import { hexGrid, hexWidthAt, nearestInDirection } from "./hexGeometry";

describe("a hexagon's width", () => {
	it("is full across its middle and narrows to its points", () => {
		const full = Math.sqrt(3) * 40;
		expect(hexWidthAt(40, 0)).toBeCloseTo(full);
		expect(hexWidthAt(40, 20)).toBeCloseTo(full);
		expect(hexWidthAt(40, -30)).toBeCloseTo(full / 2);
		expect(hexWidthAt(40, 40)).toBeCloseTo(0);
		expect(hexWidthAt(40, 50)).toBe(0);
	});
});

describe("moving between cells by arrow key", () => {
	// Three rows of four, every other row shifted half a cell.
	const { centers } = hexGrid(12, 4, 40);
	const cells = centers.map((center, index) => ({ key: String(index), ...center }));
	const from = (key: string) => cells.find((cell) => cell.key === key)!;
	const go = (key: string, direction: "up" | "down" | "left" | "right") =>
		nearestInDirection(from(key), cells, direction);

	it("goes to the neighbour beside it, left and right", () => {
		expect(go("1", "right")).toBe("2");
		expect(go("1", "left")).toBe("0");
		expect(go("5", "left")).toBe("4");
	});

	it("goes to a neighbour in the row above or below, never skipping a row", () => {
		expect(["5", "6"]).toContain(go("2", "down"));
		expect(["1", "2"]).toContain(go("5", "up"));
		expect(["9", "8"]).toContain(go("5", "down"));
	});

	it("comes back where it started: down then up, up then down", () => {
		for (const key of ["1", "2", "5", "6"]) {
			const down = go(key, "down");
			if (down) expect(go(down, "up")).toBe(key);
			const up = go(key, "up");
			if (up) expect(go(up, "down")).toBe(key);
		}
	});

	it("stays put at an edge", () => {
		expect(go("0", "left")).toBeUndefined();
		expect(go("0", "up")).toBeUndefined();
		expect(go("11", "down")).toBeUndefined();
	});

	it("crosses into the next group of cells below", () => {
		const below = { key: "next", x: 60, y: 400 };
		expect(nearestInDirection(from("9"), [...cells, below], "down")).toBe("next");
	});
});
