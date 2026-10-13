import type { ReactNode } from "react";
import type { ChangeStatus, StatusKind, Tone } from "../lib/changeStatus";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { Badge } from "./ui/badge";

/** The icon for a change's status: open changes share one shape, colored by how they stand. */
export function statusIconName(kind: StatusKind): IconName {
	switch (kind) {
		case "merged":
			return "merge";
		case "abandoned":
			return "ban";
		case "needs-you":
			return "alert";
		default:
			return "pull";
	}
}

/** A tone as a text color. */
export const TONE_TEXT: Record<Tone, string> = {
	good: "text-good",
	bad: "text-bad",
	warn: "text-warn",
	needs: "text-needs",
	accent: "text-link",
	neutral: "text-neutral",
};

export function StatusIcon({
	status,
	size = 16,
}: {
	status: Pick<ChangeStatus, "kind" | "tone" | "label">;
	size?: number;
}) {
	return (
		<span
			className={cn("mt-0.75 inline-flex shrink-0 transition-colors duration-base", TONE_TEXT[status.tone])}
			title={status.label}
		>
			<Icon name={statusIconName(status.kind)} size={size} label={status.label} />
		</span>
	);
}

/** A colored status pill, e.g. "● Open", "Merged", "Needs you"; a size smaller beside a change row's title (sm). */
export function StatusPill({
	status,
	size = "md",
	solid = false,
}: {
	status: Pick<ChangeStatus, "kind" | "tone" | "label">;
	size?: "sm" | "md" | "lg";
	solid?: boolean;
}) {
	return (
		<Badge tone={status.tone} solid={solid} size={size === "md" ? "default" : size}>
			<Icon name={statusIconName(status.kind)} size={size === "lg" ? 16 : 13} />
			{status.label}
		</Badge>
	);
}

export function TonePill({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: IconName }) {
	return (
		<Badge tone={tone}>
			{icon ? <Icon name={icon} size={13} /> : null}
			{children}
		</Badge>
	);
}

/** How a repo keeps its claims and votes: one record, or sharded (see recordsBadge), which stands out in the link's blue. */
export function ShardingBadge({ summary }: { summary: { label: string; sharded: boolean; detail: string } | null }) {
	if (!summary) return null;
	return (
		<Badge outline className={summary.sharded ? "border-link/45 text-link" : undefined} title={summary.detail}>
			{summary.label}
			<span className="sr-only">: {summary.detail}</span>
		</Badge>
	);
}
