import type { ReactNode } from "react";
import { cn } from "../lib/utils";

// A small set of line icons (24px grid, drawn with currentColor), so status
// colors come from the surrounding text color.

const PATHS = {
	check: <path d="M20 6 9 17l-5-5" />,
	x: <path d="M18 6 6 18M6 6l12 12" />,
	open: (
		<>
			<circle cx="12" cy="12" r="9" />
			<circle cx="12" cy="12" r="2.5" fill="currentColor" />
		</>
	),
	pull: (
		<>
			<circle cx="18" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" />
		</>
	),
	merge: (
		<>
			<circle cx="18" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<path d="M6 21V9a9 9 0 0 0 9 9" />
		</>
	),
	ban: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="m5.7 5.7 12.6 12.6" />
		</>
	),
	alert: (
		<>
			<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
			<path d="M12 9v4M12 17h.01" />
		</>
	),
	"x-circle": (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="m15 9-6 6M9 9l6 6" />
		</>
	),
	"check-circle": (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="m8.5 12 2.5 2.5 4.5-5" />
		</>
	),
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	loader: <path d="M21 12a9 9 0 1 1-6.22-8.56" />,
	dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
	comment: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
	commit: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M3 12h6M15 12h6" />
		</>
	),
	eye: (
		<>
			<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	repo: <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />,
	// An organization: a building of several floors.
	org: (
		<>
			<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
			<path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
			<path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
		</>
	),
	search: (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</>
	),
	plus: <path d="M12 5v14M5 12h14" />,
	file: (
		<>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<path d="M14 2v6h6" />
		</>
	),
	shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
	user: (
		<>
			<circle cx="12" cy="8" r="4" />
			<path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
		</>
	),
	bot: (
		<>
			<rect x="4" y="8" width="16" height="12" rx="2" />
			<path d="M12 8V4H8M2 14h2M20 14h2M15 13v2M9 13v2" />
		</>
	),
	folder: (
		<path
			d={
				"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 " +
				"0 0-2 2v13c0 1.1.9 2 2 2Z"
			}
		/>
	),
	pause: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M10 15V9M14 15V9" />
		</>
	),
	send: (
		<>
			<path d="m22 2-7 20-4-9-9-4Z" />
			<path d="M22 2 11 13" />
		</>
	),
	rerun: (
		<>
			<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
			<path d="M3 3v5h5" />
		</>
	),
	activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
	settings: (
		<>
			<path d="M20 7h-9M14 17H5" />
			<circle cx="17" cy="17" r="3" />
			<circle cx="7" cy="7" r="3" />
		</>
	),
	chevron: <path d="m6 9 6 6 6-6" />,
	arrow: <path d="M5 12h14m-7-7 7 7-7 7" />,
	conflict: (
		<>
			<path d="M6 3v12M18 9v12" />
			<circle cx="6" cy="18" r="3" />
			<circle cx="18" cy="6" r="3" />
			<path d="m3 3 18 18" />
		</>
	),
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
		</>
	),
	moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
	monitor: (
		<>
			<rect width="20" height="14" x="2" y="3" rx="2" />
			<path d="M8 21h8m-4-4v4" />
		</>
	),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/** Three sizes: 14 beside small text (13px and under), 16 beside body text and alone in a button, 28 over an empty
 * state's heading. */
export type IconSize = 14 | 16 | 28;

export function Icon({
	name,
	size = 16,
	className,
	label,
}: {
	name: IconName;
	size?: IconSize;
	className?: string;
	label?: string;
}) {
	return (
		<svg
			className={cn(name === "loader" && "animate-[spin_1.1s_linear_infinite]", className)}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			focusable="false"
		>
			{PATHS[name]}
		</svg>
	);
}
