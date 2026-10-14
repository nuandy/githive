import { describe, expect, it } from "vitest";
import { repoTag } from "../src/clef";
import type { WorkerUse } from "../src/usage/analytics";
import { ownUsage, PRICES, repoOfObject } from "../src/usage/own-usage";

// A person's usage is their repos' objects and Clef calls, and a share of the Worker's own requests, CPU and storage:
// never another person's repos.

const object = (name: string, requests: number, activeMs = 0, rows = { read: 0, written: 0 }) => ({
	name,
	requests,
	activeMs,
	rowsRead: rows.read,
	rowsWritten: rows.written,
});

const use: WorkerUse = {
	from: "2026-10-13T00:00:00.000Z",
	to: "2026-10-14T00:00:00.000Z",
	objects: [
		object("repo:ana--shop", 3_000_000, 800_000_000, { read: 2_000_000, written: 1_000_000 }),
		object("agent:ana--shop:githive-scout", 1_000_000, 400_000_000),
		object("record:ana--shop:refs/notes/githive-claims/ana--shop", 500_000),
		object("ana--shop", 500_000),
		object("repo:bo--blog", 4_000_000, 2_000_000_000),
		object("all", 1_000_000),
	],
	requests: 20_000_000,
	cpuMs: 10_000_000,
	storedBytes: 10e9,
	neurons: { [repoTag("blueprint", "ana--shop")]: 1000, [repoTag("blueprint", "bo--blog")]: 5000, "": 700 },
};

const ana = [{ id: "ana--shop", fullName: "ana/shop" }];

describe("a person's own usage", () => {
	it("finds a repo in each name GitHive gives its objects, and nowhere else", () => {
		const ids = new Set(["ana--shop"]);
		expect(repoOfObject("repo:ana--shop", ids)).toBe("ana--shop");
		expect(repoOfObject("agent:ana--shop:githive-scout", ids)).toBe("ana--shop");
		expect(repoOfObject("record:ana--shop:refs/notes/githive-claims/ana--shop", ids)).toBe("ana--shop");
		expect(repoOfObject("ana--shop", ids)).toBe("ana--shop");
		expect(repoOfObject("repo:ana--shop-old", ids)).toBeUndefined();
		expect(repoOfObject("all", ids)).toBeUndefined();
	});

	it("counts only their repos' objects and Clef calls, by the Worker's tag", () => {
		const usage = ownUsage(use, "blueprint", ana);
		expect(usage.repos).toHaveLength(1);
		expect(usage.repos[0]).toMatchObject({
			repo: "ana/shop",
			objectRequests: 5_000_000,
			activeSeconds: 1_200_000,
			rowsRead: 2_000_000,
			rowsWritten: 1_000_000,
			clefNeurons: 1000,
		});
		// Another Worker's tag for the same repo isn't theirs here.
		expect(ownUsage(use, "blueprint-bench", ana).repos[0]!.clefNeurons).toBe(0);
		expect(JSON.stringify(usage)).not.toContain("bo");
	});

	it("prices it at list prices, and shares out what isn't reported per repo by object requests", () => {
		const usage = ownUsage(use, "blueprint", ana);
		const gbSeconds = 1_200_000 * 0.125;
		const expected =
			5 * PRICES.objectRequestsPerMillion +
			(gbSeconds / 1e6) * PRICES.gbSecondsPerMillion +
			2 * PRICES.rowsReadPerMillion +
			1 * PRICES.rowsWrittenPerMillion +
			1 * PRICES.neuronsPerThousand;
		expect(usage.repos[0]!.cost).toBeCloseTo(expected, 4);
		// 5 of the Worker's 10 million object requests are theirs.
		expect(usage.shared).toMatchObject({ share: 0.5, workerRequests: 10_000_000, cpuMs: 5_000_000, storedBytes: 5e9 });
		const storage = 5 * PRICES.storedGbMonth * (1 / 30);
		const shared = 10 * PRICES.workerRequestsPerMillion + 5 * PRICES.cpuPerMillionMs + storage;
		expect(usage.shared.cost).toBeCloseTo(shared, 4);
		expect(usage.total).toBeCloseTo(usage.repos[0]!.cost + usage.shared.cost, 3);
	});

	it("shows nothing used for someone with no repos, and no share", () => {
		const usage = ownUsage(use, "blueprint", []);
		expect(usage.repos).toEqual([]);
		expect(usage.shared).toMatchObject({ share: 0, cost: 0 });
		expect(usage.total).toBe(0);
	});
});
