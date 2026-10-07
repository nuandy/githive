/** GitHive's mark: a beehive (a skep), stacked bands and an entrance, on honey. */
export function HiveMark({ size = 24 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
			<rect width="32" height="32" rx="7" fill="#f2a516" />
			<g fill="#fff" stroke="#f2a516" strokeWidth="1.2">
				<rect x="12" y="5.5" width="8" height="5" rx="2.5" />
				<rect x="9" y="10" width="14" height="5" rx="2.5" />
				<rect x="7" y="14.5" width="18" height="5" rx="2.5" />
				<rect x="6" y="19" width="20" height="5.5" rx="2.75" />
			</g>
			<rect x="4.5" y="24.2" width="23" height="2.6" rx="1.3" fill="#fff" />
			<path d="M13.6 24.4a2.4 2.4 0 0 1 4.8 0z" fill="#7a4a06" />
		</svg>
	);
}
