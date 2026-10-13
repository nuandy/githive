import { describe, expect, it } from "vitest";
import { batchSize, MAX_BATCH, MIN_BATCH } from "../src/toolkit/merge-batch";
import * as dashboard from "../web/src/lib/batchSize";

// The dashboard says how many changes land with one it's asked to land; it sizes batches as the server does.

describe("the dashboard's batch size", () => {
	it("is the server's", () => {
		expect(dashboard.MIN_BATCH).toBe(MIN_BATCH);
		expect(dashboard.MAX_BATCH).toBe(MAX_BATCH);
		const outcomes = (landed: number, failed: number) => [
			...Array.from({ length: landed }, () => ({ how: "landed" as const })),
			...Array.from({ length: failed }, () => ({ how: "failed" as const })),
		];
		for (const [landed, failed] of [
			[0, 0],
			[10, 0],
			[200, 0],
			[30, 3],
			[50, 10],
			[0, 10],
			[190, 10],
		] as const)
			expect(dashboard.batchSize(outcomes(landed, failed))).toBe(batchSize(outcomes(landed, failed)));
	});
});
