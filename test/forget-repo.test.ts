import { describe, expect, it } from "vitest";
import { forgetRepo } from "../src/routes/shared";

// Deleting a repo clears every object keyed by its name, so a new repo by that name starts with nothing of the old one.

describe("forgetting a deleted repo", () => {
	it("clears its tokens, caches, GitHub sync state and snapshot", async () => {
		const cleared: string[] = [];
		const object = (calls: Record<string, () => unknown>) => ({
			getByName: (name: string) =>
				Object.fromEntries(
					Object.entries(calls).map(([method, result]) => [
						method,
						async () => {
							cleared.push(`${name} ${method}`);
							return result();
						},
					]),
				),
		});
		const env = {
			TOKENS: object({ clear: () => undefined }),
			REPO_CACHE: object({ clearViews: () => ["records:acme--web:0"] }),
			RECORD_CACHE: object({ forget: () => undefined }),
			CHANGE_CACHE: object({ forget: () => undefined }),
			FOOTPRINT_CACHE: object({ forget: () => undefined }),
			GITHUB_SYNC: object({ forget: () => undefined }),
			GATE: object({ forgetSnapshot: () => undefined }),
		};
		await forgetRepo(env as never, "acme--web");
		expect(cleared.sort()).toEqual([
			"acme--web clear",
			"changes:acme--web forget",
			"footprints:acme--web forget",
			"records:acme--web:0 forget",
			"repo:acme--web clearViews",
			"repo:acme--web forget",
			"repo:acme--web forgetSnapshot",
		]);
	});
});
