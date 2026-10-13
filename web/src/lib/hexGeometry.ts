// Where the hive map's hexagons go: pointy-top cells in rows, every other row shifted half a cell.

const round = (value: number) => Math.round(value * 100) / 100;

/** A pointy-top hexagon's corners around (cx, cy), as an SVG points list. */
export function hexPoints(cx: number, cy: number, radius: number): string {
	const corners: string[] = [];
	for (let corner = 0; corner < 6; corner++) {
		const angle = (Math.PI / 180) * (60 * corner - 90);
		corners.push(`${round(cx + radius * Math.cos(angle))},${round(cy + radius * Math.sin(angle))}`);
	}
	return corners.join(" ");
}

/** Cell centers for `count` cells in rows of `columns`, and the map's size. `top` leaves room above the first row. */
export function hexGrid(
	count: number,
	columns: number,
	radius: number,
	top = 0,
): { centers: { x: number; y: number }[]; width: number; height: number } {
	const perRow = Math.max(1, Math.min(columns, count || 1));
	const cellWidth = Math.sqrt(3) * radius;
	const rowHeight = 1.5 * radius;
	const rows = Math.max(1, Math.ceil(count / perRow));
	const centers = Array.from({ length: count }, (_, index) => {
		const row = Math.floor(index / perRow);
		const column = index % perRow;
		const shift = row % 2 ? cellWidth / 2 : 0;
		return { x: round(cellWidth / 2 + column * cellWidth + shift), y: round(top + radius + row * rowHeight) };
	});
	return {
		centers,
		width: round(perRow * cellWidth + (rows > 1 ? cellWidth / 2 : 0)),
		height: round(top + 2 * radius + (rows - 1) * rowHeight),
	};
}

/** How wide a pointy-top hexagon is `y` above or below its center: full across its middle, narrowing to its points. */
export function hexWidthAt(radius: number, y: number): number {
	const off = Math.abs(y);
	if (off >= radius) return 0;
	const full = Math.sqrt(3) * radius;
	return off <= radius / 2 ? full : full * ((radius - off) / (radius / 2));
}

export type Direction = "up" | "down" | "left" | "right";

const AXIS: Record<Direction, { x: number; y: number }> = {
	up: { x: 0, y: -1 },
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
};

/**
 * The cell an arrow key moves to: the nearest one that way, counting a step aside as much as a step ahead, so a
 * neighbour in the next row beats one two rows on. Up and down have two neighbours as near as each other; down
 * takes the left one and up the right, so down then up comes back. Nothing that way: undefined.
 */
export function nearestInDirection<T extends { key: string; x: number; y: number }>(
	from: { x: number; y: number },
	cells: T[],
	direction: Direction,
): string | undefined {
	const axis = AXIS[direction];
	let best: { key: string; score: number; x: number } | undefined;
	for (const cell of cells) {
		const dx = cell.x - from.x;
		const dy = cell.y - from.y;
		const ahead = dx * axis.x + dy * axis.y;
		// Ahead of it by a few pixels at least: a cell in the same row isn't above it.
		if (ahead < 4) continue;
		const aside = Math.abs(dx * axis.y - dy * axis.x);
		// Further aside than ahead is another direction's.
		if (aside > ahead * 2) continue;
		const score = ahead + aside;
		const better =
			!best ||
			score < best.score - 1 ||
			(Math.abs(score - best.score) <= 1 && (direction === "up" ? cell.x > best.x : cell.x < best.x));
		if (better) best = { key: cell.key, score, x: cell.x };
	}
	return best?.key;
}
