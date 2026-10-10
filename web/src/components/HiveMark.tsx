/**
 * GitHive's mark: a comb cell with a track running into it and its lamp lit,
 * centered in the cell. An ink tile with paper lines, flipped on dark (the
 * --mark-* tokens); the lamp is always amber.
 */
export function HiveMark({ size = 24 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
			<rect width="32" height="32" rx="7" style={{ fill: "var(--mark-tile)" }} />
			<path
				d="M10.2 6.5h11.6l5.8 9.5-5.8 9.5H10.2L4.4 16z"
				fill="none"
				strokeWidth="2.6"
				strokeLinejoin="round"
				style={{ stroke: "var(--mark-line)" }}
			/>
			<path d="M4.4 16H12" strokeWidth="2.6" strokeLinecap="round" style={{ stroke: "var(--mark-line)" }} />
			<circle cx="16" cy="16" r="4" fill="#e59a0b" />
		</svg>
	);
}
