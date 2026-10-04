import { describe, expect, it } from "vitest";
import { audit, type MergeRecord } from "../src/free/audit";
import type { Registry } from "../src/free/claims";

// The coordinator-free audit: nothing stopped an agent from breaking a
// convention, so a pure replay of the records reports every violation, with
// the commit and the agent responsible.

const at = (claims: Registry["claims"]) => ({ claims });
const claimA = { change: "stats-1a2b", agent: "agent-a", paths: ["src/stats/"], intent: "Add stats", since: "" };
const claimB = { change: "docs-3c4d", agent: "agent-b", paths: ["docs/"], intent: "Docs", since: "" };
// The registry's history, oldest first: a's claim, then b's too.
const registry = [
	{ tip: "r1", state: at([claimA]) },
	{ tip: "r2", state: at([claimA, claimB]) },
];
const merge = (overrides: Partial<MergeRecord>): MergeRecord => ({ commit: "m1", author: "agent-a", change: "stats-1a2b", claimsTip: "r2", files: ["src/stats/index.ts"], ...overrides });

describe("the audit", () => {
	it("finds nothing wrong with a merge inside its own claim", () => {
		expect(audit({ registry, merges: [merge({})] })).toEqual([]);
	});

	it("reports a merge that changed files outside its claim", () => {
		expect(audit({ registry, merges: [merge({ files: ["src/stats/index.ts", "src/router.ts"] })] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "outside-claim", detail: "src/router.ts was not in stats-1a2b's claim at r2" },
		]);
	});

	it("reports a merge that edited inside another change's claim, naming whose", () => {
		expect(audit({ registry, merges: [merge({ files: ["src/stats/index.ts", "docs/stats.md"] })] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "inside-another-claim", detail: "docs/stats.md was claimed by docs-3c4d (agent-b) at r2" },
		]);
	});

	it("reports, once, a merge that doesn't declare its change or the claims it checked", () => {
		expect(audit({ registry, merges: [merge({ change: undefined, claimsTip: undefined, files: ["a.ts", "b.ts"] })] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "undeclared", detail: "the merge names no change or claims it checked (Blueprint-Change, Blueprint-Claims)" },
		]);
	});

	it("reports, once, a merge citing a registry tip the registry never had", () => {
		expect(audit({ registry, merges: [merge({ claimsTip: "made-up" })] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unknown-claims", detail: "made-up is not in the claims registry's history" },
		]);
	});
});
