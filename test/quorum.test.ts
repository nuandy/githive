import { describe, expect, it } from "vitest";
import { tally, validatePolicy } from "../src/quorum";
import type { Review, ReviewPolicy } from "../src/types";

const policy: ReviewPolicy = { reviewers: ["security", "tests", "api"], required: 2, vetoes: ["security"] };

const review = (reviewer: string, verdict: Review["verdict"], head = "h1"): Review => ({
	reviewer,
	verdict,
	head,
	summary: "",
	at: "2026-10-02T00:00:00Z",
});

describe("tally", () => {
	it("is pending until a head is pinned", () => {
		expect(tally(policy, { reviews: [] }).status).toBe("pending");
	});

	it("approves once enough reviewers approve", () => {
		const slice = { reviewHead: "h1", reviews: [review("tests", "approve"), review("api", "approve")] };
		expect(tally(policy, slice)).toMatchObject({ status: "approved", waiting: ["security"] });
	});

	it("lets a veto role block an otherwise approved slice", () => {
		const slice = {
			reviewHead: "h1",
			reviews: [review("tests", "approve"), review("api", "approve"), review("security", "reject")],
		};
		expect(tally(policy, slice).status).toBe("vetoed");
	});

	it("rejects once approval can no longer be reached", () => {
		const slice = { reviewHead: "h1", reviews: [review("tests", "reject"), review("api", "reject")] };
		expect(tally(policy, slice).status).toBe("rejected");
	});

	it("ignores reviews of an older head", () => {
		const slice = { reviewHead: "h2", reviews: [review("tests", "approve"), review("api", "approve")] };
		expect(tally(policy, slice)).toMatchObject({ status: "pending", approvals: [] });
	});

	it("counts only a reviewer's latest verdict", () => {
		const slice = {
			reviewHead: "h1",
			reviews: [review("tests", "reject"), review("tests", "approve"), review("api", "approve")],
		};
		expect(tally(policy, slice).status).toBe("approved");
	});
});

describe("validatePolicy", () => {
	it("rejects impossible quorums and unknown veto roles", () => {
		expect(() => validatePolicy({ ...policy, required: 4 })).toThrow(/between 1 and 3/);
		expect(() => validatePolicy({ ...policy, vetoes: ["perf"] })).toThrow(/not reviewers/);
		expect(() => validatePolicy(policy)).not.toThrow();
	});
});
