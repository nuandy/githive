import { describe, expect, it } from "vitest";
import {
	heldReviews,
	holdReview,
	releaseReview,
	type ReviewHolds,
	reviewHolds,
	roleWaits,
	roleWaitTold,
} from "../src/toolkit/review-holds";
import { MemoryLog } from "./helpers/memory-log";

// Review holds as records in Git. reviews offers a review only while fewer
// agents hold it than it needs, so two agents aren't sent to one review that
// needs one. The record also keeps when each review awaited by a blocking role
// was first seen waiting, so people are told once about a review that waited too
// long.

describe("review holds, as a record", () => {
	it("holds a review for as many agents as it needs, by compare-and-swap, until they vote or it expires", async () => {
		const log = new MemoryLog<ReviewHolds>();
		const t0 = 1_000_000;
		const at = (ms: number) => () => t0 + ms;
		expect(await holdReview(log, "h1#review", "agent-a", 1, at(0))).toBe(true);
		// Needed once and held: the next agent is turned away; the holder may take it again.
		expect(await holdReview(log, "h1#review", "agent-b", 1, at(0))).toBe(false);
		expect(await holdReview(log, "h1#review", "agent-a", 1, at(0))).toBe(true);
		// Needed twice: room for a second.
		expect(await holdReview(log, "h1#review", "agent-b", 2, at(0))).toBe(true);
		expect(await heldReviews(log, t0)).toEqual({ "h1#review": ["agent-a", "agent-b"] });
		// Voted: held a minute more, until the vote shows everywhere, then gone.
		await releaseReview(log, "h1#review", "agent-a", { now: at(0) });
		expect(await heldReviews(log, t0 + 30_000)).toEqual({ "h1#review": ["agent-a", "agent-b"] });
		expect(await heldReviews(log, t0 + 61_000)).toEqual({ "h1#review": ["agent-b"] });
	});

	it("drops a hold at once when its agent gives the review up, so another can take it", async () => {
		const log = new MemoryLog<ReviewHolds>();
		const t0 = 1_000_000;
		await holdReview(log, "h1#review", "agent-a", 1, () => t0);
		await releaseReview(log, "h1#review", "agent-a", { now: () => t0, gaveUp: true });
		expect(await heldReviews(log, t0)).toEqual({});
		expect(await holdReview(log, "h1#review", "agent-b", 1, () => t0)).toBe(true);
	});

	it("lets holds run out, and two agents asking at once can't both take the last one", async () => {
		const log = new MemoryLog<ReviewHolds>();
		const t0 = 1_000_000;
		await holdReview(log, "h1#review", "agent-a", 1, () => t0);
		expect(await heldReviews(log, t0 + 16 * 60_000)).toEqual({});
		expect(await holdReview(log, "h1#review", "agent-b", 1, () => t0 + 16 * 60_000)).toBe(true);
		// agent-c and agent-d ask at once for a review needed once: one gets it.
		const won = await Promise.all(["agent-c", "agent-d"].map((a) => holdReview(log, "h2#review", a, 1, () => t0)));
		expect(won.filter(Boolean).length).toBe(1);
	});
});

describe("reviews a role waits for, as a record", () => {
	it("remembers when each was first seen waiting and whether people were told, forgetting one that stops", async () => {
		const log = new MemoryLog<ReviewHolds>();
		const first = await roleWaits(log, ["h1#security"]);
		expect((await roleWaits(log, ["h1#security", "h2#security"]))["h1#security"]!.since).toBe(
			first["h1#security"]!.since,
		);
		await roleWaitTold(log, "h1#security");
		expect(await roleWaits(log, ["h1#security"])).toEqual({
			"h1#security": { since: first["h1#security"]!.since, told: true },
		});
		// h1's review was taken; when it waits again, its clock starts over.
		await roleWaits(log, []);
		expect((await roleWaits(log, ["h1#security"]))["h1#security"]!.told).toBeUndefined();
	});

	it("writes only when the reviews waiting change", async () => {
		const log = new MemoryLog<ReviewHolds>();
		await roleWaits(log, ["h1#security"]);
		const commits = log.commits.length;
		await roleWaits(log, ["h1#security"]);
		await roleWaits(log, ["h1#security"]);
		expect(log.commits.length).toBe(commits);
	});
});

describe("review holds, split by commit", () => {
	it("keeps holds on different commits in different records, and reads only the buckets asked about", async () => {
		const buckets = new Map<string, MemoryLog<ReviewHolds>>();
		const read: string[] = [];
		const logOf = (bucket: string) => {
			read.push(bucket);
			if (!buckets.has(bucket)) buckets.set(bucket, new MemoryLog<ReviewHolds>());
			return buckets.get(bucket) as MemoryLog<ReviewHolds>;
		};
		const holds = reviewHolds({ waits: () => new MemoryLog<ReviewHolds>(), holds: (_repo, bucket) => logOf(bucket) });
		const first = `000001${"a".repeat(34)}`;
		const second = `000002${"b".repeat(34)}`;
		expect(await holds.hold("p", `${first}#review`, "agent-a", 1)).toBe(true);
		expect(await holds.hold("p", `${second}#review`, "agent-b", 1)).toBe(true);
		expect([...buckets.keys()].sort()).toEqual(["1", "2"]);
		read.length = 0;
		expect(await holds.held("p", [first])).toEqual({ [`${first}#review`]: ["agent-a"] });
		expect(read).toEqual(["1"]);
		// Named no heads, it reads them all.
		expect(Object.keys(await holds.held("p")).sort()).toEqual([`${first}#review`, `${second}#review`]);
	});
});
