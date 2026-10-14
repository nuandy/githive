import { afterEach, describe, expect, it, vi } from "vitest";
import { repoTag } from "../src/clef";
import type { WorkerUse } from "../src/usage/analytics";
import { keptFor } from "../src/usage/kept";
import { hourlyCosts, type HourlyRead } from "../src/usage/own-hours";
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
	namespaces: ["repo-cache", "hosted-agent"],
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
		// Only its price is sent: with the share and the amounts, anyone could work out the Worker's totals.
		expect(Object.keys(usage.shared)).toEqual(["cost"]);
		const storage = 5 * PRICES.storedGbMonth * (1 / 30);
		const shared = 10 * PRICES.workerRequestsPerMillion + 5 * PRICES.cpuPerMillionMs + storage;
		expect(usage.shared.cost).toBeCloseTo(shared, 4);
		expect(usage.total).toBeCloseTo(usage.repos[0]!.cost + usage.shared.cost, 3);
	});

	it("shows nothing used for someone with no repos, and no share", () => {
		const usage = ownUsage(use, "blueprint", []);
		expect(usage.repos).toEqual([]);
		expect(usage.shared).toEqual({ cost: 0 });
		expect(usage.total).toBe(0);
	});
});

const at = (hour: string, sum: Record<string, number>, dimensions: Record<string, string> = {}) => ({
	sum,
	dimensions: { datetimeHour: `2026-10-13T${hour}:00:00Z`, ...dimensions },
});

// ana's objects' hours, the Worker's own, and Clef by tag, adding up to the totals in `use` above.
const read: HourlyRead = {
	objects: [at("02", { requests: 2_000_000 }), at("09", { requests: 3_000_000 })],
	periodic: [
		at("02", { activeTime: 400_000e6, rowsRead: 2_000_000, rowsWritten: 0 }),
		at("09", { activeTime: 800_000e6, rowsRead: 0, rowsWritten: 1_000_000 }),
	],
	worker: [
		at("02", { requests: 5_000_000, cpuTimeUs: 2_500_000e3 }),
		at("09", { requests: 15_000_000, cpuTimeUs: 7_500_000e3 }),
	],
	ai: [
		at("09", { totalNeurons: 1000 }, { tag: repoTag("blueprint", "ana--shop") }),
		at("09", { totalNeurons: 5000 }, { tag: repoTag("blueprint", "bo--blog") }),
	],
};

describe("a person's usage hour by hour", () => {
	const hours = hourlyCosts(use, "blueprint", ana, read);
	const sum = (part: "own" | "shared") => hours.reduce((total, hour) => total + hour[part], 0);

	it("has every hour of the window, oldest first, the empty ones at nothing but stored data", () => {
		expect(hours[0]!.hour).toBe("2026-10-13T00:00:00.000Z");
		expect(hours.at(-1)!.hour).toBe("2026-10-14T00:00:00.000Z");
		expect(hours[1]).toMatchObject({ own: 0 });
		expect(hours[1]!.shared).toBeGreaterThan(0);
	});

	it("adds up to the table: their repos' cost and their share", () => {
		const usage = ownUsage(use, "blueprint", ana);
		expect(sum("own")).toBeCloseTo(usage.repos[0]!.cost, 3);
		expect(sum("shared")).toBeCloseTo(usage.shared.cost, 3);
	});

	it("puts each cost in its hour, and only their own Clef calls", () => {
		const hour = (time: string) => hours.find((each) => each.hour === `2026-10-13T${time}:00:00.000Z`)!;
		const requests = 3 * PRICES.objectRequestsPerMillion;
		const duration = ((800_000 * 0.125) / 1e6) * PRICES.gbSecondsPerMillion;
		const clef = 1 * PRICES.neuronsPerThousand;
		expect(hour("09").own).toBeCloseTo(requests + duration + PRICES.rowsWrittenPerMillion + clef, 5);
		expect(hour("03").own).toBe(0);
	});

	it("is nothing at all for someone with no repos", () => {
		const none = hourlyCosts(use, "blueprint", [], { objects: [], periodic: [], worker: read.worker, ai: [] });
		expect(none.every((hour) => hour.own === 0 && hour.shared === 0)).toBe(true);
	});
});

describe("usage reads kept in the Worker's cache", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("are kept on the Worker's own host, and a second read is answered from there", async () => {
		const kept = new Map<string, Response>();
		vi.stubGlobal("caches", {
			default: {
				match: async (request: Request) => kept.get(request.url)?.clone(),
				put: async (request: Request, response: Response) => void kept.set(request.url, response),
			},
		});
		let reads = 0;
		const read = async () => ({ requests: ++reads });
		expect(await keptFor("https://githive.app", "usage/blueprint/24h", 600, read)).toEqual({
			value: { requests: 1 },
			kept: false,
		});
		expect([...kept.keys()]).toEqual(["https://githive.app/_kept/usage/blueprint/24h"]);
		expect(await keptFor("https://githive.app", "usage/blueprint/24h", 600, read)).toEqual({
			value: { requests: 1 },
			kept: true,
		});
		expect(reads).toBe(1);
	});
});
