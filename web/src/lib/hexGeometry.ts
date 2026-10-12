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
