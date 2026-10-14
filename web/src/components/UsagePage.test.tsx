import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UsageReport } from "../api";
import { parseRoute } from "../lib/routes";
import { visibleText } from "../test/fixtures";
import { dollars, duration, UsageTable } from "./UsagePage";

const report: UsageReport = {
	range: "24h",
	from: "2026-10-13T12:00:00.000Z",
	to: "2026-10-14T12:00:00.000Z",
	repos: [
		{
			repo: "ana/shop",
			objectRequests: 43_000,
			activeSeconds: 12_600,
			rowsRead: 90_000,
			rowsWritten: 21_000,
			clefNeurons: 174,
			cost: 0.0331,
		},
	],
	shared: { cost: 0.0042 },
	total: 0.0373,
};

describe("the Usage page", () => {
	it("lists each of your repos with what it used and cost, then your share of the Worker, then the total", () => {
		const text = visibleText(renderToStaticMarkup(<UsageTable usage={report} />));
		expect(text).toContain("ana/shop");
		expect(text).toContain("43K");
		expect(text).toContain("3.5 h");
		expect(text).toContain("$0.03");
		expect(text).toContain("requests, CPU and storage, estimated");
		expect(text).toMatch(/Total\s*\$0\.04/);
		expect(text).toContain("Priced at list prices before the Workers Paid plan");
	});

	it("says when your repos used nothing", () => {
		const none = { ...report, repos: [], total: 0, shared: { cost: 0 } };
		expect(visibleText(renderToStaticMarkup(<UsageTable usage={none} />))).toContain(
			"Your repos used nothing in this range.",
		);
	});

	it("writes amounts and times as people read them", () => {
		expect(dollars(0)).toBe("$0.00");
		expect(dollars(0.004)).toBe("under $0.01");
		expect(dollars(1.234)).toBe("$1.23");
		expect(duration(42)).toBe("42 s");
		expect(duration(1080)).toBe("18 min");
		expect(duration(12_600)).toBe("3.5 h");
	});

	it("is at #/usage", () => {
		expect(parseRoute("#/usage")).toEqual({ page: "usage" });
	});
});
