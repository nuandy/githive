import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { approve, makeChange, makeTask, stubApi } from "../test/fixtures";
import { ChangePage } from "./ChangePage";
import { ReviewForm } from "./ReviewForm";

const task = makeTask({ review: { reviewers: ["tests", "security"], required: 2, vetoes: ["security"] } });
const api = { submitReview: vi.fn() };
const render = (change: ReturnType<typeof makeChange>) => renderToStaticMarkup(<ReviewForm task={task} change={change} api={api} onChanged={() => undefined} />);

describe("Review changes, from the dashboard", () => {
	it("offers the change's roles, suggesting the first without a vote, with Approve and Request changes", () => {
		const html = render(makeChange({ reviewHead: "a1b2c3d4e5", reviews: [approve("tests", "a1b2c3d4e5")] }));
		expect(html).toContain("Review changes");
		expect(html).toContain("a1b2c3d");
		expect(html).toMatch(/<option value="tests">tests reviewer<\/option><option value="security" selected="">security reviewer<\/option>/);
		expect(html).toContain("Approve");
		expect(html).toContain("Request changes");
		expect(html).toMatch(/<textarea id="review-summary"[^>]*required=""/);
		expect(html).toContain("Evidence");
		expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>.*Submit review/);
		expect(api.submitReview).not.toHaveBeenCalled();
	});

	it("isn't offered when there's nothing to review", () => {
		expect(render(makeChange())).toBe("");
		expect(render(makeChange({ reviewHead: "h1", sentBackFor: "h1" }))).toBe("");
		expect(render(makeChange({ reviewHead: "h1", status: "integrated" }))).toBe("");
		expect(render(makeChange({ reviewHead: "h1", status: "abandoned" }))).toBe("");
	});

	it("sits at the end of a change's conversation", () => {
		const change = makeChange({ reviewHead: "h1" });
		const html = renderToStaticMarkup(<ChangePage task={makeTask({ slices: [change] })} change={change} repo="my-app" base="repos" tab="conversation" history={null} api={stubApi()} onChanged={() => undefined} />);
		expect(html.indexOf("Merge status")).toBeLessThan(html.indexOf("Review changes"));
		expect(html.indexOf("Review changes")).toBeLessThan(html.indexOf("change-sidebar"));
	});
});
