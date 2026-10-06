import { describe, expect, it } from "vitest";
import { dayLabel, shortAge, timeAgo, timeUntil } from "./relativeTime";

const now = Date.parse("2025-01-02T12:00:00.000Z");
const minus = (ms: number) => new Date(now - ms).toISOString();

describe("relative times", () => {
	it("says how long ago, in words", () => {
		expect(timeAgo(minus(30_000), now)).toBe("just now");
		expect(timeAgo(minus(60_000), now)).toBe("1 minute ago");
		expect(timeAgo(minus(5 * 60_000), now)).toBe("5 minutes ago");
		expect(timeAgo(minus(2 * 3_600_000), now)).toBe("2 hours ago");
		expect(timeAgo(minus(3 * 86_400_000), now)).toBe("3 days ago");
		expect(timeAgo(minus(40 * 86_400_000), now)).toBe(new Date(now - 40 * 86_400_000).toLocaleDateString());
	});

	it("has a compact form for dense lists", () => {
		expect(shortAge(minus(10_000), now)).toBe("now");
		expect(shortAge(minus(5 * 60_000), now)).toBe("5m");
		expect(shortAge(minus(2 * 3_600_000), now)).toBe("2h");
		expect(shortAge(minus(86_400_000), now)).toBe("1d");
	});

	it("says when something is due", () => {
		expect(timeUntil(new Date(now + 25 * 60_000).toISOString(), now)).toBe("in 25 minutes");
		expect(timeUntil(new Date(now + 2 * 3_600_000).toISOString(), now)).toBe("in 2 hours");
		expect(timeUntil(minus(5 * 60_000), now)).toBe("5 minutes ago");
	});

	it("groups by day", () => {
		expect(dayLabel(minus(60_000), now)).toBe("Today");
		expect(dayLabel(minus(86_400_000), now)).toBe("Yesterday");
		expect(dayLabel(undefined, now)).toBe("Earlier");
	});

	it("never throws on bad data", () => {
		expect(timeAgo("not-a-timestamp", now)).toBe("not-a-timestamp");
		expect(timeAgo(undefined, now)).toBe("");
		expect(shortAge("nope", now)).toBe("");
		expect(timeUntil("nope", now)).toBe("");
	});
});
