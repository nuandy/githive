// The Usage page's report: what the admin's repos used, hour by hour, in a working day's shape. Worked out, not
// random, so the page reads the same on every run.

import type { HourCost, UsageReport } from "../../src/api.ts";
import { FIXED_NOW } from "./clock.ts";

const HOUR_MS = 3_600_000;

/** What an hour cost: busiest in the afternoon (UTC), quietest at night, a little more on later days. */
function hourAt(time: number, days: number): HourCost {
	const hourOfDay = new Date(time).getUTCHours();
	const daytime = Math.max(0, Math.sin(((hourOfDay - 6) / 16) * Math.PI));
	const own = 0.0004 + daytime * (0.009 + 0.001 * ((days * 7 + hourOfDay) % 5));
	return { hour: new Date(time).toISOString(), own: Math.round(own * 1e6) / 1e6, shared: 0.0006 + daytime * 0.0012 };
}

export function usageReport(range: UsageReport["range"]): UsageReport {
	const span = range === "24h" ? 24 : 7 * 24;
	const first = Math.floor((FIXED_NOW - span * HOUR_MS) / HOUR_MS) * HOUR_MS;
	const hours: HourCost[] = [];
	for (let time = first; time <= FIXED_NOW; time += HOUR_MS) hours.push(hourAt(time, (time - first) / 86_400_000));
	const own = hours.reduce((total, hour) => total + hour.own, 0);
	const shared = hours.reduce((total, hour) => total + hour.shared, 0);
	return {
		range,
		from: new Date(FIXED_NOW - span * HOUR_MS).toISOString(),
		to: new Date(FIXED_NOW).toISOString(),
		repos: [
			{
				repo: "acme/storefront",
				objectRequests: 41_000 * span,
				activeSeconds: 520 * span,
				rowsRead: 90_000 * span,
				rowsWritten: 800 * span,
				clefNeurons: 7 * span,
				cost: Math.round(own * 0.8 * 1e4) / 1e4,
			},
			{
				repo: "robin/notes",
				objectRequests: 9_000 * span,
				activeSeconds: 130 * span,
				rowsRead: 20_000 * span,
				rowsWritten: 200 * span,
				clefNeurons: span,
				cost: Math.round(own * 0.2 * 1e4) / 1e4,
			},
		],
		shared: { cost: Math.round(shared * 1e4) / 1e4 },
		total: Math.round((own + shared) * 1e4) / 1e4,
		hours,
	};
}
