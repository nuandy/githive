import type { ReactNode } from "react";
import type { ChangeStatus, StatusKind, Tone } from "../lib/changeStatus";
import { STATES } from "../lib/status";
import { cn } from "../lib/utils";
import { Icon, type IconName, type IconSize } from "./Icon";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** The icon for a change's state, from its one look (see status.ts). */
export function statusIconName(kind: StatusKind): IconName {
	return STATES[kind].icon;
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

/** A status as its icon alone, its words on hover (and, for whoever can't see it, as its name). */
export function StatusIcon({
	status,
	size = 16,
}: {
	status: Pick<ChangeStatus, "kind" | "tone" | "label">;
	size?: IconSize;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className={cn("mt-0.75 inline-flex shrink-0 transition-colors duration-base", TONE_TEXT[status.tone])}>
					<Icon name={statusIconName(status.kind)} size={size} label={status.label} />
				</span>
			</TooltipTrigger>
			<TooltipContent>{status.label}</TooltipContent>
		</Tooltip>
	);
}

/** A change's state as a pill, its icon and its noun ("Needs a person", "Landed"); smaller beside a row's title (sm). */
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
			<Icon name={statusIconName(status.kind)} size={size === "lg" ? 16 : 14} />
			{status.label}
		</Badge>
	);
}

export function TonePill({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: IconName }) {
	return (
		<Badge tone={tone}>
			{icon ? <Icon name={icon} size={14} /> : null}
			{children}
		</Badge>
	);
}

/**
 * How a repo keeps its claims and votes: one record, or sharded (see recordsBadge), which stands out in the link's
 * blue. What that means shows on hover or focus.
 */
export function ShardingBadge({ summary }: { summary: { label: string; sharded: boolean; detail: string } | null }) {
	if (!summary) return null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge tabIndex={0} outline className={summary.sharded ? "border-link/45 text-link" : undefined}>
					{summary.label}
					<span className="sr-only">: {summary.detail}</span>
				</Badge>
			</TooltipTrigger>
			<TooltipContent>{summary.detail}</TooltipContent>
		</Tooltip>
	);
}
