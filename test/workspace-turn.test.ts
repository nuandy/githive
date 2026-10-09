import { describe, expect, it } from "vitest";
import { inWorkspaceTurn } from "../src/git";

// Each call working in a workspace holds its copy of the project until it
// ends, and an isolate has 128 MB for all its requests: at most a few work
// at once, the rest waiting their turn.

describe("calls working in a workspace", () => {
	it("work 6 at once, the rest in turn, and a call that fails gives its turn up", async () => {
		let working = 0;
		let most = 0;
		const done: number[] = [];
		const call = (i: number) =>
			inWorkspaceTurn(async () => {
				most = Math.max(most, ++working);
				await new Promise((resolve) => setTimeout(resolve, 5));
				working--;
				if (i % 5 === 0) throw new Error(`call ${i} failed`);
				done.push(i);
				return i;
			});
		const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => call(i)));
		expect(most).toBe(6);
		expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(4);
		expect(done).toHaveLength(16);
		// Its turns all given back: the next 6 run at once again.
		most = 0;
		await Promise.all(Array.from({ length: 6 }, (_, i) => call(i * 5 + 1)));
		expect(most).toBe(6);
	});
});
