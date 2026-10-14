import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HourCost, UsageReport } from "../api";
import { visibleText } from "../test/fixtures";
import { amount, axisLabel, barsOf, cellsOf, cellUnit, MOST_CELLS, UsageChart } from "./UsageChart";

const HOUR_MS = 3_600_000;

/** `count` hours from local midnight on 13 Oct, each costing `own` and `shared`. */
function hours(count: number, own = 0.001, shared = 0.0005): HourCost[] {
	const start = new Date(2026, 9, 13).getTime();
	return Array.from({ length: count }, (_, index) => ({
		hour: new Date(start + index * HOUR_MS).toISOString(),
		own,
		shared,
	}));
}

const report = (range: UsageReport["range"], list: HourCost[]): UsageReport => ({
	range,
	from: list[0]!.hour,
	to: list.at(-1)!.hour,
	repos: [],
	shared: { cost: 0 },
	total: 0,
	hours: list,
});

describe("the Usage chart", () => {
	it("draws a column an hour over a day, and folds a week into six-hour blocks of local time", () => {
		expect(barsOf(hours(25), "24h")).toHaveLength(25);
		const week = barsOf(hours(7 * 24), "7d");
		expect(week).toHaveLength(28);
		expect(week[0]!.own).toBeCloseTo(0.006, 6);
		expect(week.every((bar) => bar.start.getHours() % 6 === 0)).toBe(true);
	});

	it("makes a cell a round amount that fits the busiest column in its cells", () => {
		expect(cellUnit(0.017)).toBe(0.002);
		expect(cellUnit(0.08)).toBe(0.01);
		expect(cellUnit(0.1)).toBe(0.01);
		expect(cellUnit(3)).toBe(0.5);
		for (const most of [0.0003, 0.017, 0.08, 7]) expect(most / cellUnit(most)).toBeLessThanOrEqual(MOST_CELLS);
	});

	it("stacks their repos' cells under their share's, and marks a trace of use with an outline", () => {
		const bar = { start: new Date(), end: new Date(), own: 0.006, shared: 0.002 };
		expect(cellsOf(bar, 0.002)).toEqual({ own: 3, shared: 1, trace: false });
		expect(cellsOf({ ...bar, own: 0.0001, shared: 0 }, 0.002)).toEqual({ own: 0, shared: 0, trace: true });
		expect(cellsOf({ ...bar, own: 0, shared: 0 }, 0.002)).toEqual({ own: 0, shared: 0, trace: false });
	});

	it("marks every six hours under a day, and each day under a week", () => {
		const day = barsOf(hours(25), "24h");
		expect(day.filter((bar) => axisLabel(bar, "24h"))).toHaveLength(5);
		const week = barsOf(hours(7 * 24), "7d");
		expect(axisLabel(week[0]!, "7d")).toMatch(/^\w{3} 13$/);
		expect(axisLabel(week[1]!, "7d")).toBe("");
	});

	it("writes an hour's cost to two figures under a cent", () => {
		expect(amount(0)).toBe("$0");
		expect(amount(0.00043)).toBe("$0.00043");
		expect(amount(0.123)).toBe("$0.12");
	});

	it("says what each column cost, and the busiest one, in words", () => {
		const list = hours(25);
		list[9] = { ...list[9]!, own: 0.012 };
		const text = visibleText(renderToStaticMarkup(<UsageChart usage={report("24h", list)} />));
		expect(text).toContain("Cost by hour");
		expect(text).toContain("A cell is $0.002");
		expect(text).toMatch(/Busiest hour: .+, \$0\.01/);
		const markup = renderToStaticMarkup(<UsageChart usage={report("24h", list)} />);
		expect(markup).toContain("$0.01 your repos, $0.0005 your share");
	});

	it("says why, in the chart's place, when the hours couldn't be read", () => {
		const failed = { ...report("24h", hours(2)), hours: undefined, hoursError: "unknown field datetimeHour" };
		const text = visibleText(renderToStaticMarkup(<UsageChart usage={failed} />));
		expect(text).toMatch(/The hours couldn.t be read from Cloudflare.s analytics: unknown field datetimeHour/);
	});
});
