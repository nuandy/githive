import type { ReactNode } from "react";
import type { ChangeStatus, StatusKind, Tone } from "../lib/changeStatus";
import { Icon, type IconName } from "./Icon";

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

export function StatusIcon({
	status,
	size = 16,
}: {
	status: Pick<ChangeStatus, "kind" | "tone" | "label">;
	size?: number;
}) {
	return (
		<span className={`status-icon tone-${status.tone}`} title={status.label}>
			<Icon name={statusIconName(status.kind)} size={size} label={status.label} />
		</span>
	);
}

/** A colored status pill, e.g. "● Open", "Merged", "Needs you". */
export function StatusPill({
	status,
	size = "md",
	solid = false,
}: {
	status: Pick<ChangeStatus, "kind" | "tone" | "label">;
	size?: "md" | "lg";
	solid?: boolean;
}) {
	return (
		<span className={`pill pill--${status.tone}${solid ? " pill--solid" : ""}${size === "lg" ? " pill--lg" : ""}`}>
			<Icon name={statusIconName(status.kind)} size={size === "lg" ? 16 : 13} />
			{status.label}
		</span>
	);
}

export function TonePill({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: IconName }) {
	return (
		<span className={`pill pill--${tone}`}>
			{icon ? <Icon name={icon} size={13} /> : null}
			{children}
		</span>
	);
}

/** How a repo keeps its claims and votes: one record, or sharded (see recordsBadge). */
export function ShardingBadge({ summary }: { summary: { label: string; sharded: boolean; detail: string } | null }) {
	if (!summary) return null;
	return (
		<span
			className={`pill pill--outline mode-badge${summary.sharded ? " mode-badge--sharded" : ""}`}
			title={summary.detail}
		>
			{summary.label}
			<span className="sr-only">: {summary.detail}</span>
		</span>
	);
}
