import { describe, expect, it } from "vitest";
import { isTransientFailure, retryTransient } from "../src/retry";

describe("retryTransient", () => {
	it("retries transient failures with capped exponential delays and returns the successful value", async () => {
		const waits: number[] = [];
		let attempts = 0;
		const result = await retryTransient(
			async () => {
				attempts++;
				if (attempts < 3) throw Object.assign(new Error("service unavailable"), { status: 503 });
				return "ok";
			},
			{ maxAttempts: 4, baseDelayMs: 7, maxDelayMs: 10, sleep: async (ms: number) => void waits.push(ms) },
		);

		expect(result).toBe("ok");
		expect(attempts).toBe(3);
		expect(waits).toEqual([7, 10]);
	});

	it("recognizes nested network failures and retries them", async () => {
		const network = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
		const wrapped = Object.assign(new Error("request failed"), { cause: network });
		expect(isTransientFailure(wrapped)).toBe(true);
		let attempts = 0;
		await expect(
			retryTransient(
				async () => {
					if (++attempts === 1) throw wrapped;
					return 42;
				},
				{ sleep: async () => {} },
			),
		).resolves.toBe(42);
		expect(attempts).toBe(2);
	});

	it("does not retry permanent client errors or unclassified failures", async () => {
		for (const failure of [Object.assign(new Error("unauthorized"), { status: 401 }), new Error("bad input")]) {
			let attempts = 0;
			await expect(
				retryTransient(
					async () => {
						attempts++;
						throw failure;
					},
					{ sleep: async () => {} },
				),
			).rejects.toBe(failure);
			expect(attempts).toBe(1);
		}
	});

	it("rethrows the final transient error after the configured attempt limit", async () => {
		const failure = Object.assign(new Error("busy"), { statusCode: 429 });
		let attempts = 0;
		await expect(
			retryTransient(
				async () => {
					attempts++;
					throw failure;
				},
				{ maxAttempts: 3, sleep: async () => {} },
			),
		).rejects.toBe(failure);
		expect(attempts).toBe(3);
	});
});
