import { describe, expect, it } from "vitest";
import { ago, NOW } from "../test/fixtures";
import { durationWords, JUST_FINISHED_MS, justFinished, stretchWords } from "./stretch";

// A repo's last stretch of work, in words, and whether it just finished.

const stretch = (more = {}) => ({ landed: 200, failed: 0, agents: 200, from: ago(37), to: ago(5), ...more });

describe("the last stretch of work", () => {
	it("says how much landed, how fast and by how many, and what failed checks put out", () => {
		expect(stretchWords(stretch())).toBe("200 changes in 32 minutes, by 200 agents");
		expect(stretchWords(stretch({ landed: 1, agents: 1, from: ago(5) }))).toBe(
			"1 change in under a minute, by 1 agent",
		);
		expect(stretchWords(stretch({ failed: 2 }))).toBe(
			"200 changes in 32 minutes, by 200 agents; 2 put out by failed checks",
		);
	});

	it("says a long stretch in hours and minutes", () => {
		expect(durationWords(125 * 60_000)).toBe("2 hours 5 minutes");
		expect(durationWords(60 * 60_000)).toBe("1 hour");
	});

	it("counts as just finished for a few hours, then not", () => {
		expect(justFinished(stretch(), NOW)).toBe(true);
		const old = stretch({ to: new Date(NOW - JUST_FINISHED_MS - 60_000).toISOString() });
		expect(justFinished(old, NOW)).toBe(false);
		expect(justFinished(undefined, NOW)).toBe(false);
	});
});
