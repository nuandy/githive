import { describe, expect, it } from "vitest";
import { nextStep, reviewFeedback, tally, validatePolicy } from "../src/quorum";
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

	it("approves once enough reviewers approve, every veto role among them", () => {
		const slice = { reviewHead: "h1", reviews: [review("tests", "approve"), review("security", "approve")] };
		expect(tally(policy, slice)).toMatchObject({ status: "approved", waiting: ["api"] });
	});

	it("waits for a veto role, however many others approve", () => {
		const slice = { reviewHead: "h1", reviews: [review("tests", "approve"), review("api", "approve")] };
		expect(tally(policy, slice)).toMatchObject({ status: "pending", waiting: ["security"] });
		expect(nextStep(policy, { id: "a", status: "building", reviewHead: "h1", reviews: slice.reviews } as never)).toBe("wait");
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
			reviews: [review("tests", "reject"), review("tests", "approve"), review("security", "approve")],
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

describe("nextStep", () => {
	const base = { status: "building" as const, reviewHead: "h1", id: "api", title: "", owns: [], instructions: "", touched: [], outOfLane: [] };

	it("integrates an approved slice", () => {
		expect(nextStep(policy, { ...base, reviews: [review("tests", "approve"), review("security", "approve")] })).toBe("integrate");
	});

	it("sends a vetoed slice back once per head", () => {
		const slice = { ...base, reviews: [review("security", "reject")] };
		expect(nextStep(policy, slice)).toBe("send-back");
		expect(nextStep(policy, { ...slice, sentBackFor: "h1" })).toBe("wait");
	});

	it("waits while the outcome is open", () => {
		expect(nextStep(policy, { ...base, reviews: [review("tests", "reject")] })).toBe("wait");
	});

	it("waits once the slice is integrated", () => {
		const reviews = [review("tests", "approve"), review("api", "approve")];
		expect(nextStep(policy, { ...base, status: "integrated", reviews })).toBe("wait");
	});
});

describe("reviewFeedback", () => {
	it("lists rejections with evidence and marks vetoes", () => {
		const reviews = [
			{ ...review("security", "reject"), summary: "XSS in view", evidence: "src/ui.ts:12 uses innerHTML" },
			review("tests", "approve"),
		];
		const text = reviewFeedback(policy, { reviewHead: "h1", reviews });
		expect(text).toMatch(/quorum vetoed/);
		expect(text).toMatch(/- security \(veto\) rejected: XSS in view\n  Evidence: src\/ui\.ts:12 uses innerHTML/);
		expect(text).toMatch(/Approved by: tests\./);
	});
});
