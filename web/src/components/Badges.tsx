import type { ChecksSummary, ReviewSummary } from "../lib/changeStatus";
import { Icon, type IconName } from "./Icon";

const REVIEW_ICON: Record<ReviewSummary["state"], IconName | null> = {
	none: null,
	pending: "eye",
	approved: "check",
	waived: "check",
	"changes-requested": "x",
	vetoed: "x",
};

/** "✓ 2/2 approvals", "◉ 1/2 approvals", "✗ Changes requested". */
export function ReviewBadge({ summary }: { summary: ReviewSummary }) {
	const icon = REVIEW_ICON[summary.state];
	if (!icon) return null;
	return (
		<span className={`inline-badge tone-${summary.tone}`} title={`Review: ${summary.label}`}>
			<Icon name={icon} size={14} />
			<span>{summary.label}</span>
		</span>
	);
}

const CHECKS_ICON: Record<ChecksSummary["state"], IconName | null> = {
	none: null,
	"not-run": null,
	queued: "clock",
	running: "loader",
	waiting: "clock",
	passed: "check",
	failed: "x",
};

export function ChecksBadge({ summary, compact = false }: { summary: ChecksSummary; compact?: boolean }) {
	const icon = CHECKS_ICON[summary.state];
	if (!icon) return null;
	const short = summary.state === "passed" ? "checks" : summary.state === "failed" ? "checks" : summary.label;
	return (
		<span className={`inline-badge tone-${summary.tone}`} title={summary.label}>
			<Icon name={icon} size={14} />
			<span>{compact ? short : summary.label}</span>
		</span>
	);
}
