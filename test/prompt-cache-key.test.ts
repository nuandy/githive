import { describe, expect, it } from "vitest";
import { promptCacheKey } from "../src/sandbox";

// OpenAI refuses a prompt_cache_key over 64 characters, and agent names
// (fork--<repo>--<change>) can be longer. The key must fit, stay the same for
// the same agent, and differ between agents.

describe("promptCacheKey", () => {
	it("keeps a short key as it is", () => {
		expect(promptCacheKey("builder", "t1--a")).toBe("builder-t1--a");
	});

	it("fits a long one in 64 characters, stably, and distinctly", () => {
		const long = "fork--build-demo-muu5wou0--add-a-short-contributing-da89";
		const key = promptCacheKey("reviewer", long);
		expect(key.length).toBeLessThanOrEqual(64);
		expect(key.startsWith("reviewer-fork--build-demo")).toBe(true);
		expect(promptCacheKey("reviewer", long)).toBe(key);
		expect(promptCacheKey("reviewer", `${long}x`)).not.toBe(key);
	});
});
