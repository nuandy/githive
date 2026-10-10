// Relative times. `now` is injectable so tests are deterministic.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

const millisOf = (now: number | Date) => (now instanceof Date ? now.getTime() : now);

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago", then a date. */
export function timeAgo(isoTime: string | undefined, now: number | Date = Date.now()): string {
	if (!isoTime) return "";
	const timestamp = Date.parse(isoTime);
	if (!Number.isFinite(timestamp)) return isoTime;
	const age = millisOf(now) - timestamp;
	if (!Number.isFinite(age)) return new Date(timestamp).toLocaleDateString();
	if (age < MINUTE) return "just now";
	if (age < HOUR) return `${plural(Math.floor(age / MINUTE), "minute")} ago`;
	if (age < DAY) return `${plural(Math.floor(age / HOUR), "hour")} ago`;
	if (age < 30 * DAY) return `${plural(Math.floor(age / DAY), "day")} ago`;
	return new Date(timestamp).toLocaleDateString();
}

/** Compact age for dense lists: "now", "5m", "2h", "3d", then a date. */
export function shortAge(isoTime: string | undefined, now: number | Date = Date.now()): string {
	if (!isoTime) return "";
	const timestamp = Date.parse(isoTime);
	if (!Number.isFinite(timestamp)) return "";
	const age = millisOf(now) - timestamp;
	if (age < MINUTE) return "now";
	if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
	if (age < DAY) return `${Math.floor(age / HOUR)}h`;
	if (age < 30 * DAY) return `${Math.floor(age / DAY)}d`;
	return new Date(timestamp).toLocaleDateString();
}

/** "in 25 minutes" / "5 minutes ago" for a time that may be in the future. */
export function timeUntil(isoTime: string | undefined, now: number | Date = Date.now()): string {
	if (!isoTime) return "";
	const timestamp = Date.parse(isoTime);
	if (!Number.isFinite(timestamp)) return "";
	const ahead = timestamp - millisOf(now);
	if (ahead <= 0) return timeAgo(isoTime, now);
	if (ahead < HOUR) return `in ${plural(Math.max(1, Math.round(ahead / MINUTE)), "minute")}`;
	if (ahead < DAY) return `in ${plural(Math.round(ahead / HOUR), "hour")}`;
	return `in ${plural(Math.round(ahead / DAY), "day")}`;
}

/** Day heading for grouped activity: "Today", "Yesterday", or a date. */
export function dayLabel(isoTime: string | undefined, now: number | Date = Date.now()): string {
	const timestamp = isoTime ? Date.parse(isoTime) : NaN;
	if (!Number.isFinite(timestamp)) return "Earlier";
	const day = new Date(timestamp);
	const today = new Date(millisOf(now));
	const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const daysAgo = Math.round((startOf(today) - startOf(day)) / DAY);
	if (daysAgo === 0) return "Today";
	if (daysAgo === 1) return "Yesterday";
	return day.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
