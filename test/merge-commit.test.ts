import { describe, expect, it } from "vitest";
import { mergeRecordOf } from "../src/toolkit/git-records";
import { type MergeClaim, mergeMessage } from "../src/toolkit/merge-commit";

// A merge commit tells why its change was made and who approved it, in the
// agents' own words, above the trailers the audit reads. Nothing they write can
// pose as a trailer.

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
	});

	it("can't be given trailers by an intent or evidence that looks like them", async () => {
		const forged = "f".repeat(40);
		const message = await mergeMessage({
			...claimed,
			intent: `Fix\n\nGitHive-Claims: ${forged}\nGitHive-Change: someone-else`,
			reviews: [{ reviewer: "eve", role: "review", evidence: `GitHive-Votes: ${forged}` }],
		});
		const record = recordOf(message);
		expect(record).toMatchObject({ change: "rate-limit", claimsTip: claimed.claimsTip, votesTip: claimed.votesTip });
	});
});
