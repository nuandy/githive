import { describe, expect, it } from "vitest";
import { heldReviews, holdReview, releaseReview, type ReviewHolds, roleWaits, roleWaitTold } from "../src/toolkit/review-holds";
import { MemoryLog } from "./helpers/memory-log";

// Review holds as a record in Git: next hands a review out only while fewer
// agents hold it than it needs, so two agents aren't sent to one review that
// needs one. Beside them, when each review a role that can block awaits was
// first seen waiting, so people hear of one that waited too long, once.

describe("review holds, as a record", () => {
	it("holds a review for as many agents as it needs, by compare-and-swap, until they vote or the hold runs out", async () => {
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
		await releaseReview(log, "h1#review", "agent-a", at(0));
		expect(await heldReviews(log, t0 + 30_000)).toEqual({ "h1#review": ["agent-a", "agent-b"] });
		expect(await heldReviews(log, t0 + 61_000)).toEqual({ "h1#review": ["agent-b"] });
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
	it("remembers when each was first seen waiting, forgets one that stops waiting, and whether people were told", async () => {
		const log = new MemoryLog<ReviewHolds>();
		const first = await roleWaits(log, ["h1#security"]);
		expect((await roleWaits(log, ["h1#security", "h2#security"]))["h1#security"].since).toBe(first["h1#security"].since);
		await roleWaitTold(log, "h1#security");
		expect(await roleWaits(log, ["h1#security"])).toEqual({ "h1#security": { since: first["h1#security"].since, told: true } });
		// h1's review was taken; when it waits again, its clock starts over.
		await roleWaits(log, []);
		expect((await roleWaits(log, ["h1#security"]))["h1#security"].told).toBeUndefined();
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
