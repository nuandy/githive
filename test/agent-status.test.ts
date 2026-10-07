import { describe, expect, it } from "vitest";
import { reviewerName } from "../src/artifacts";
import { hostedAgentStatus } from "../src/toolkit/env";

// What status and the dashboard show of GitHive's hosted agents on a
// change: its builder, and the reviewers of its current head that have run.

describe("hostedAgentStatus", () => {
	it("reports the builder and each role's reviewer of the head, skipping those that never ran", async () => {
		const env = {
			BUILDER: { getByName: (name: string) => ({ state: async () => (name === "fork--p--c-1" ? { status: "working", revisions: 1 } : null) }) },
			REVIEWER: {
				getByName: (name: string) => ({
					state: async () => (name === reviewerName("fork--p--c-1", "tests", "h2") ? { status: "done", verdict: "reject" } : null),
				}),
			},
		};
		expect(await hostedAgentStatus(env as never, "p", "c-1", "h2", ["tests", "security"])).toEqual({
			builder: { status: "working", revisions: 1 },
			reviewers: [{ role: "tests", status: "done", verdict: "reject" }],
		});
		expect(await hostedAgentStatus(env as never, "p", "other", null, ["tests"])).toEqual({ reviewers: [] });
	});
});
