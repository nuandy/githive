import { describe, expect, it } from "vitest";
import { changeAt, RULES, violationWords } from "./auditWords";

// Every rule the server's audit reports (src/toolkit/audit.ts), in words a person reads, with what they can do.
const SERVER_RULES = [
	"undeclared",
	"unverified",
	"inside-another-claim",
	"outside-claim",
	"merged-before-dependency",
	"untested",
	"unjustified-revert",
	"unknown-claims",
	"unverified-record",
	"released-before-merge",
	"unknown-votes",
	"unapproved",
	"released-others-claim",
];

describe("the audit's rules in words", () => {
	it("words every rule the server reports, each with a remedy", () => {
		expect(Object.keys(RULES).sort()).toEqual([...SERVER_RULES].sort());
		for (const rule of SERVER_RULES) {
			const { words, remedy } = violationWords(rule);
			expect(words, rule).not.toMatch(/-/);
			expect(words[0], rule).toBe(words[0]!.toUpperCase());
			expect(remedy, rule).toMatch(/\.$/);
		}
		expect(violationWords("outside-claim").words).toBe("Changed files outside its claim");
		expect(violationWords("undeclared").words).toBe("Landed without GitHive's records");
	});

	it("words a rule it doesn't know from its id, and still says what to do", () => {
		expect(violationWords("some-new-rule")).toEqual({
			words: "Some new rule",
			remedy: expect.stringMatching(/revert/),
		});
	});
});

describe("a reviewed commit's change", () => {
	const claims = [
		{ change: "coupons", intent: "Let shoppers apply a coupon.\n\nMore.", head: "8007f9e12345" },
		{ change: "building", intent: "", head: null },
	];
	const landed = [{ change: "prices", title: "Format prices", head: "fe9c07d00000" }];

	it("is the open change whose head it is, or the landed one's, by a full or short hash", () => {
		expect(changeAt("8007f9e", claims, landed)).toEqual({ change: "coupons", title: "Let shoppers apply a coupon." });
		expect(changeAt("8007f9e12345abcdef", claims, landed)?.change).toBe("coupons");
		expect(changeAt("fe9c07d", claims, landed)).toEqual({ change: "prices", title: "Format prices" });
		expect(changeAt("343327a", claims, landed)).toBeUndefined();
		expect(changeAt("", claims, landed)).toBeUndefined();
	});
});
