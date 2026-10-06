import { describe, expect, it } from "vitest";
import { reviewerName } from "../src/artifacts";
import { freeAgentStatus } from "../src/free/env";

// What free_status and the dashboard show of Blueprint's hosted agents on a
// change: its builder, and the reviewers of its current head that have run.

describe("freeAgentStatus", () => {
	it("reports the builder and each role's reviewer of the head, skipping those that never ran", async () => {
		const env = {
			BUILDER: { getByName: (name: string) => ({ state: async () => (name === "free--p--c-1" ? { status: "working", revisions: 1 } : null) }) },
			REVIEWER: {
				getByName: (name: string) => ({
					state: async () => (name === reviewerName("free--p--c-1", "tests", "h2") ? { status: "done", verdict: "reject" } : null),
				}),
			},
		};
		expect(await freeAgentStatus(env as never, "p", "c-1", "h2", ["tests", "security"])).toEqual({
			builder: { status: "working", revisions: 1 },
			reviewers: [{ role: "tests", status: "done", verdict: "reject" }],
		});
		expect(await freeAgentStatus(env as never, "p", "other", null, ["tests"])).toEqual({ reviewers: [] });
	});
});
