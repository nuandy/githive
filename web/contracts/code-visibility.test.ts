import { describe, expect, it, vi } from "vitest";
import { api, liveFeedUrl } from "../src/api";

// The dashboard's calls for what a person sees and decides on a change: its
// code, its history, and a person's vote.

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

	it("browses code, reads a change and posts a person's vote", async () => {
		const request = mockFetch(new Map<string, unknown>([
			["/repos/team%2Fapp/tree?ref=master", { ref: "master", commit: "abc", files: ["a.ts"], truncated: false }],
			["/repos/team%2Fapp/tree", { ref: "main", commit: "abc", files: [], truncated: false }],
			["/repos/team%2Fapp/file?path=src%2Fa%20b.ts&ref=abc", { ref: "abc", commit: "abc", path: "src/a b.ts", size: 3, text: "hi\n" }],
			["/repos/docs/changes/c-1", { change: "c-1", branch: "main", claim: null, released: [], commits: [], votes: [] }],
			["/repos/docs/changes/c-1/votes", { commit: "h1", role: "security", verdict: "reject" }],
		]));
		try {
			await api.tree("team/app", "master");
			await api.tree("team/app");
			await expect(api.file("team/app", "src/a b.ts", "abc")).resolves.toMatchObject({ text: "hi\n" });
			await api.change("docs", "c-1");
			await api.vote("docs", "c-1", { role: "security", verdict: "reject", evidence: "Leaks the token" });
			const calls = request.mock.calls.map(([input, init]) => [String(input), init?.method ?? "GET"]);
			expect(calls.map(([, method]) => method)).toEqual(["GET", "GET", "GET", "GET", "POST"]);
			expect(JSON.parse(String(request.mock.calls[4][1]?.body))).toEqual({ role: "security", verdict: "reject", evidence: "Leaks the token" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("shows the server's words when a vote is refused", async () => {
		globalThis.fetch = (async () => Response.json({ error: "only a person signed in through Access votes from the dashboard" }, { status: 403 })) as unknown as typeof fetch;
		try {
			await expect(api.vote("docs", "c-1", { role: "review", verdict: "approve", evidence: "ok" })).rejects.toThrow("only a person signed in through Access votes from the dashboard");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("opens a repo's live feed on the same host", () => {
		expect(liveFeedUrl("repo:docs", { protocol: "https:", host: "githive.example" })).toBe("wss://githive.example/live/repo:docs");
		expect(liveFeedUrl("repo:docs", { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/live/repo:docs");
	});
});
