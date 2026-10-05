import { describe, expect, it, vi } from "vitest";
import { api, liveFeedUrl } from "../src/api";

// The dashboard's calls for what a person sees and decides on a change: its
// diff, the repo's decision log, and the human actions.

function mockFetch(responses: Map<string, unknown>) {
	const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const body = responses.get(String(input));
		if (body === undefined) throw new Error(`Unexpected request: ${String(input)}`);
		return Response.json(body);
	});
	globalThis.fetch = request as unknown as typeof fetch;
	return request;
}

describe("dashboard change API", () => {
	const originalFetch = globalThis.fetch;

	it("loads a pinned diff with all/omitted file lists and posts a waiver reason", async () => {
		const request = mockFetch(new Map<string, unknown>([
			["/tasks/task%20%2F1/slices/slice%2Fone/diff", { base: "base-sha", head: "review-sha", unified: "--- a/file.ts\n+++ b/file.ts\n", files: ["file.ts", "large.json"], omitted: ["large.json"] }],
			["/tasks/task%20%2F1/slices/slice%2Fone/waive", { waived: true }],
		]));
		try {
			await expect(api.sliceDiff("task /1", "slice/one")).resolves.toMatchObject({ base: "base-sha", head: "review-sha", files: ["file.ts", "large.json"], omitted: ["large.json"] });
			await api.waive("task /1", "slice/one", "Human accepts this review risk");
			expect(request.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST"]);
			expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ reason: "Human accepts this review risk" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("messages a builder, re-runs checks and abandons a change on the server's routes", async () => {
		const request = mockFetch(new Map<string, unknown>([
			["/tasks/t/slices/c/message", { delivered: "resumed" }],
			["/tasks/t/slices/c/gate", {}],
			["/tasks/t/changes/c/abandon", { id: "c", status: "abandoned" }],
		]));
		try {
			await expect(api.messageBuilder("t", "c", "Use the new helper")).resolves.toEqual({ delivered: "resumed" });
			await api.retryChecks("t", "c");
			await api.abandon("t", "c", "Superseded");
			expect(request.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
				["/tasks/t/slices/c/message", "POST"],
				["/tasks/t/slices/c/gate", "POST"],
				["/tasks/t/changes/c/abandon", "POST"],
			]);
			expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ message: "Use the new helper" });
			expect(JSON.parse(String(request.mock.calls[2][1]?.body))).toEqual({ reason: "Superseded" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("reads the repo's decision log and drops malformed entries", async () => {
		mockFetch(new Map<string, unknown>([["/tasks/t%2F1/history", { entries: [{ at: "2026-10-06T00:00:00Z", text: "Change a opened", commit: "abc" }, { at: 1 }, null, { text: "no time" }] }]]));
		try {
			await expect(api.history("t/1")).resolves.toEqual([
				{ at: "2026-10-06T00:00:00Z", text: "Change a opened", commit: "abc" },
				{ at: "", text: "no time", commit: "" },
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("reviews, saves settings, reads who leads, browses code and reads a coordinator-free change", async () => {
		const request = mockFetch(new Map<string, unknown>([
			["/tasks/t/slices/c/reviews", { ok: true }],
			["/tasks/t/settings", { review: { reviewers: ["review"], required: 1, vetoes: [] }, verify: [], leaseMinutes: 30 }],
			["/tasks/t/leader", { leader: "t--c", term: 2 }],
			["/repos/team%2Fapp/tree?ref=master", { ref: "master", commit: "abc", files: ["a.ts"], truncated: false }],
			["/repos/team%2Fapp/tree", { ref: "main", commit: "abc", files: [], truncated: false }],
			["/repos/team%2Fapp/file?path=src%2Fa%20b.ts&ref=abc", { ref: "abc", commit: "abc", path: "src/a b.ts", size: 3, text: "hi\n" }],
			["/free/docs/changes/c-1", { change: "c-1", branch: "main", claim: null, released: [], commits: [], votes: [] }],
		]));
		try {
			await api.submitReview("t", "c", { reviewer: "security", head: "h1", verdict: "reject", summary: "Leaks the token", evidence: "curl -v" });
			await expect(api.updateSettings("t", { leaseMinutes: 30 })).resolves.toMatchObject({ leaseMinutes: 30 });
			await expect(api.leader("t")).resolves.toEqual({ leader: "t--c", term: 2 });
			await api.tree("team/app", "master");
			await api.tree("team/app");
			await expect(api.file("team/app", "src/a b.ts", "abc")).resolves.toMatchObject({ text: "hi\n" });
			await api.freeChange("docs", "c-1");
			const calls = request.mock.calls.map(([input, init]) => [String(input), init?.method ?? "GET"]);
			expect(calls.map(([, method]) => method)).toEqual(["POST", "PATCH", "GET", "GET", "GET", "GET", "GET"]);
			expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ reviewer: "security", head: "h1", verdict: "reject", summary: "Leaks the token", evidence: "curl -v" });
			expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ leaseMinutes: 30 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("shows the server's words when a review is refused", async () => {
		globalThis.fetch = (async () => Response.json({ error: "you opened this change, so you can't review it" }, { status: 403 })) as unknown as typeof fetch;
		try {
			await expect(api.submitReview("t", "c", { reviewer: "review", head: "h", verdict: "approve", summary: "ok" })).rejects.toThrow("you opened this change, so you can't review it");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("opens a repo's live feed on the same host", () => {
		expect(liveFeedUrl("task:abcd1234", { protocol: "https:", host: "blueprint.example" })).toBe("wss://blueprint.example/live/task:abcd1234");
		expect(liveFeedUrl("free:docs", { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/live/free:docs");
	});
});
