import { describe, expect, it } from "vitest";
import { answer } from "./fixtures.ts";
import { STOREFRONT } from "./fixtures/storefront.ts";

// The fixtures server answers writes as if they worked, so the dashboard shows what a success looks like.

const post = (path: string) => answer("POST", new URL(path, "http://localhost"), "admin");

describe("writes on the fixtures server", () => {
	it("lands a change, with the commit it landed as", () => {
		const landed = post("/repos/acme/storefront/changes/checkout-tax/merge");
		expect(landed?.status).toBe(200);
		expect(landed?.body).toMatchObject({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
	});

	it("releases a change's claim", () => {
		expect(post("/repos/acme/storefront/changes/checkout-tax/release")?.body).toMatchObject({ ok: true });
	});

	it("answers any other write with nothing much", () => {
		expect(post("/repos/acme/storefront/changes/checkout-tax/votes")?.body).toEqual({});
		expect(post("/orgs")?.body).toEqual({});
	});
});

describe("a change's approval in the fixtures", () => {
	it("names who blocked it, as the server does, and still waits on the role they blocked as", () => {
		const blocked = STOREFRONT.hive?.snapshot.claims.filter((claim) => claim.approval.vetoedBy.length) ?? [];
		expect(blocked.length).toBeGreaterThan(0);
		const roles = new Set([...STOREFRONT.hive!.snapshot.policy.vetoes, "payments"]);
		for (const claim of blocked)
			for (const name of claim.approval.vetoedBy) {
				expect(roles.has(name)).toBe(false);
				expect(claim.approval.awaiting?.length).toBeGreaterThan(0);
			}
	});
});
