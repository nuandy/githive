import type { LandingStretch } from "../api";
import { counted } from "./plural";

// A repo's last stretch of work (what landed since it last went quiet), in words, and whether it just finished:
// how the dashboard says "all landed" instead of only going quiet.

/** How long after its last landing a stretch still counts as just finished. */
export const JUST_FINISHED_MS = 3 * 60 * 60_000;

export function justFinished(stretch: LandingStretch | undefined, now = Date.now()): stretch is LandingStretch {
	if (!stretch) return false;
	return now - Date.parse(stretch.to) <= JUST_FINISHED_MS;
}

/** How long something took: "under a minute", "32 minutes", "2 hours 5 minutes". */
export function durationWords(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return counted(minutes, "minute");
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${counted(hours, "hour")} ${counted(rest, "minute")}` : counted(hours, "hour");
}

/** "200 changes in 32 minutes, by 200 agents", and how many failed checks put out, if any. */
export function stretchWords(stretch: LandingStretch): string {
	const took = durationWords(Date.parse(stretch.to) - Date.parse(stretch.from));
	const landed = `${counted(stretch.landed, "change")} in ${took}, by ${counted(stretch.agents, "agent")}`;
	if (!stretch.failed) return landed;
	return `${landed}; ${stretch.failed} put out by failed checks`;
}
