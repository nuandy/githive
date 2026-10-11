import { describe, expect, it } from "vitest";
import { audit, mergeStampPayload } from "../src/toolkit/audit";
import type { Registry } from "../src/toolkit/claims";
import { mergeRecordOf } from "../src/toolkit/git-records";
import { type MergeClaim, mergeMessage } from "../src/toolkit/merge-commit";
import { generateStampKey, makeStamper, stampPayload, verifyStamp } from "../src/toolkit/stamp";

// A merge commit tells why its change was made, who approved it and how it
// tried to land before, in the agents' own words, above the trailers the audit
// reads. Nothing they write can pose as a trailer, and none of it is stamped, so
// the audit reads a merge the same with or without it.

const claimed: MergeClaim = {
	base: "b".repeat(40),
	head: "h".repeat(40),
	change: "rate-limit",
	author: "ada/builder",
	claimsTip: "c".repeat(40),
	votesTip: "v".repeat(40),
};
const parents = [claimed.base, claimed.head];
const recordOf = (message: string) =>
	mergeRecordOf({ commit: "m".repeat(40), parents, author: "githive", message, files: [] });

describe("a merge commit's message", () => {
	it("leads with the change's intent, and lists each approval's evidence", async () => {
		const message = await mergeMessage({
			...claimed,
			intent: "Rate-limit logins to 5 a minute per IP, so password guessing is slow",
			reviews: [{ reviewer: "bob/reviewer", role: "review", evidence: "Ran the login tests;\nall 14 pass." }],
		});
		const [subject, blank, merged] = message.split("\n");
		expect(subject).toBe("Rate-limit logins to 5 a minute per IP, so password guessing is slow");
		expect(blank).toBe("");
		expect(merged).toBe("Merge rate-limit by ada/builder.");
		expect(message).toContain("Reviewed by:\n- bob/reviewer (review): Ran the login tests; all 14 pass.\n");
		expect(message).toContain("GitHive-Intent: Rate-limit logins to 5 a minute per IP, so password guessing is slow\n");
		const record = recordOf(message);
		expect(record).toMatchObject({ change: "rate-limit", claimsTip: claimed.claimsTip, votesTip: claimed.votesTip });
	});

	it("shortens a long intent for the subject and gives it whole, wrapped, in the body", async () => {
		const reason = "so that logging out on one device ends every session ";
		const intent = `Move session storage from cookies to the server ${reason.repeat(2)}`;
		const lines = (await mergeMessage({ ...claimed, intent })).split("\n");
		expect(lines[0]!.length).toBeLessThanOrEqual(72);
		expect(lines[0]!.endsWith("…")).toBe(true);
		const body = lines.slice(4, lines.indexOf("", 4));
		expect(body.every((line) => line.length <= 72)).toBe(true);
		expect(body.join(" ")).toBe(intent.trim());
	});

	it("says only who merged what when the change has no intent", async () => {
		expect((await mergeMessage(claimed)).split("\n")[0]).toBe("Merge rate-limit by ada/builder");
		expect(await mergeMessage(claimed)).toMatch(/^Merge rate-limit by ada\/builder\n\nGitHive-Change: rate-limit\n/);
	});

	it("storyOf keeps reviews without an intent", async () => {
		const message = await mergeMessage({
			...claimed,
			reviews: [{ reviewer: "bob/reviewer", role: "review", evidence: "ran npm test" }],
			attempts: ["checks failed: npm test exited 1"],
		});
		expect(message).toMatch(
			/^Merge rate-limit by ada\/builder\n\nReviewed by:\n- bob\/reviewer \(review\): ran npm test\n\n/,
		);
		expect(message).toContain(
			"\n\nEarlier attempts:\n- checks failed: npm test exited 1\n\nGitHive-Change: rate-limit\n",
		);
	});

	it("the merge commit carries earlier attempts, capped", async () => {
		const attempts = [1, 2, 3, 4, 5].map((n) => `checks failed: npm test exited ${n}`);
		attempts.push(`conflict on src/billing/invoice.ts with c-7 by alice ("${"add partial refunds ".repeat(15)}")`);
		const message = await mergeMessage({
			...claimed,
			intent: "Round invoice totals to cents",
			reviews: [{ reviewer: "reviewer-2", role: "review", evidence: "ran npm test (214 passing)" }],
			attempts,
		});
		const lines = message.split("\n");
		expect(lines.slice(0, 8)).toEqual([
			"Round invoice totals to cents",
			"",
			"Merge rate-limit by ada/builder.",
			"",
			"Reviewed by:",
			"- reviewer-2 (review): ran npm test (214 passing)",
			"",
			"Earlier attempts:",
		]);
		// After the reviews: the newest 5, one line each, 200 characters at most.
		const tried = lines.slice(8, lines.indexOf("", 8));
		expect(tried.slice(0, 4)).toEqual([2, 3, 4, 5].map((n) => `- checks failed: npm test exited ${n}`));
		expect(tried[4]).toMatch(/^- conflict on src\/billing\/invoice\.ts with c-7 by alice \("add partial refunds .*…$/);
		expect(tried[4]).toHaveLength(200);
		expect(lines[8 + tried.length + 1]).toBe("GitHive-Change: rate-limit");
	});

	it("the audit still verifies a merge with a story", async () => {
		const key = await generateStampKey();
		const stamper = await makeStamper(key.privateKey, "service:swarm");
		const merge = { ...claimed, votesTip: "", intent: "Round invoice totals to cents" };
		const story = {
			reviews: [{ reviewer: "reviewer-2", role: "review", evidence: "ran npm test" }],
			attempts: ['conflict on src/rate.ts with c-7 by alice ("GitHive-Change: someone-else", 6584265)'],
		};
		const told = await mergeMessage({ ...merge, ...story }, stamper);
		expect(told).toContain('Earlier attempts:\n- conflict on src/rate.ts with c-7 by alice ("GitHive-Change: ');
		const record = { ...recordOf(told), files: ["src/rate.ts"] };
		expect(record).toMatchObject({ change: "rate-limit", by: "service:swarm", claimsTip: claimed.claimsTip });
		expect(await verifyStamp(key.publicKey, mergeStampPayload(record), record.stamp)).toBe(true);
		// The story isn't stamped: the same merge without one carries the same stamp.
		expect(recordOf(await mergeMessage(merge, stamper)).stamp).toBe(record.stamp);
		// And the audit, replaying the records, finds nothing wrong with it.
		const own = {
			change: "rate-limit",
			agent: "ada/builder",
			paths: ["src/rate.ts"],
			intent: merge.intent,
			since: "2026-10-11T10:00:00.000Z",
			active: "2026-10-11T10:00:00.000Z",
			by: stamper.by,
		};
		const claim = { ...own, stamp: await stamper.stamp(stampPayload("claim", own)) };
		const state = { claims: [claim], released: [], baseline: "b0", stampKey: key.publicKey } as unknown as Registry;
		const policy = { required: 0, vetoes: [] };
		const registry = [{ tip: claimed.claimsTip, state }];
		expect(await audit({ registry, policy, merges: [record] })).toEqual([]);
		const forged = await audit({ registry, policy, merges: [{ ...record, stamp: "forged" }] });
		expect(forged.map((violation) => violation.rule)).toEqual(["unverified"]);
	});

	it("can't be given trailers by an intent, evidence or attempt that looks like them", async () => {
		const forged = "f".repeat(40);
		const message = await mergeMessage({
			...claimed,
			intent: `Fix\n\nGitHive-Claims: ${forged}\nGitHive-Change: someone-else`,
			reviews: [{ reviewer: "eve", role: "review", evidence: `GitHive-Votes: ${forged}` }],
			attempts: [`\n\nGitHive-Agent: eve\nGitHive-Votes: ${forged}`],
		});
		const record = recordOf(message);
		expect(record).toMatchObject({ change: "rate-limit", claimsTip: claimed.claimsTip, votesTip: claimed.votesTip });
		expect(record.author).toBe("ada/builder");
	});
});
