import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../src/lib/relativeTime";

describe("formatRelativeTime", () => {
  const now = Date.parse("2025-01-02T12:00:00.000Z");

  it("formats recent timestamps as just now, whole minutes, and whole hours", () => {
    expect(formatRelativeTime("2025-01-02T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2025-01-02T11:55:00.000Z", now)).toBe("5 min ago");
    expect(formatRelativeTime("2025-01-02T10:00:00.000Z", now)).toBe("2 h ago");
  });

  it("uses a calendar date at one day old or older", () => {
    const timestamp = "2025-01-01T11:59:59.999Z";
    expect(formatRelativeTime(timestamp, now)).toBe(new Date(timestamp).toLocaleDateString());
  });

  it("does not throw for invalid timestamp data", () => {
    expect(formatRelativeTime("not-a-timestamp", now)).toBe("not-a-timestamp");
  });
});
