import { describe, expect, it } from "vitest";
import { keepVoteDraft, readVoteDraft, voteDraftKey } from "./voteDraft";

// A vote half written outlives leaving the page: kept for the session, per repo, change and commit.

function memory() {
	const items = new Map<string, string>();
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	};
}

describe("a vote's draft", () => {
	const key = voteDraftKey("acme/web", "checkout-tax", "4e6df04");

	it("is kept per repo, change and commit", () => {
		expect(key).not.toBe(voteDraftKey("acme/web", "checkout-tax", "9f8e7d6"));
		expect(key).not.toBe(voteDraftKey("acme/web", "footer-links", "4e6df04"));
		expect(key).not.toBe(voteDraftKey("acme/docs", "checkout-tax", "4e6df04"));
	});

	it("comes back as it was left: the verdict, the role and the words", () => {
		const store = memory();
		keepVoteDraft(store, key, { choice: "approve", role: "payments", evidence: "Ran the refunds by hand" });
		expect(readVoteDraft(store, key)).toEqual({
			choice: "approve",
			role: "payments",
			evidence: "Ran the refunds by hand",
		});
	});

	it("is dropped once there's nothing in it, and reads as nothing when missing or unreadable", () => {
		const store = memory();
		keepVoteDraft(store, key, { choice: "request", evidence: "" });
		keepVoteDraft(store, key, { choice: null, evidence: "  " });
		expect(store.items.size).toBe(0);
		expect(readVoteDraft(store, key)).toEqual({});
		store.setItem(key, "{not json");
		expect(readVoteDraft(store, key)).toEqual({});
		store.setItem(key, JSON.stringify({ choice: "shout", role: 3, evidence: "ok" }));
		expect(readVoteDraft(store, key)).toEqual({ evidence: "ok" });
		expect(readVoteDraft(undefined, key)).toEqual({});
	});
});
