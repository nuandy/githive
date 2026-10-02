import { describe, expect, it } from "vitest";
import { gateExclusions, gateFeedback, type GateResult } from "../src/gate-plan";

const slice = (id: string, status: "building" | "integrated", tests: string[]) => ({ id, status, tests });

describe("gateExclusions", () => {
	it("leaves out tests that belong only to slices not yet integrated", () => {
		const slices = [
			slice("api", "building", ["test/api.test.ts"]),
			slice("ui", "building", ["test/ui.test.ts", "test/shared.test.ts"]),
			slice("core", "integrated", ["test/core.test.ts", "test/shared.test.ts"]),
		];
		expect(gateExclusions(slices, "api")).toEqual(["test/ui.test.ts"]);
	});

	it("keeps everything once the other slices are integrated", () => {
		const slices = [slice("api", "building", ["test/api.test.ts"]), slice("ui", "integrated", ["test/ui.test.ts"])];
		expect(gateExclusions(slices, "api")).toEqual([]);
	});
});

describe("gateFeedback", () => {
	const base: GateResult = { passed: false, head: "h", baseHead: "b", results: [], at: "2026-10-02T00:00:00Z" };

	it("quotes the first failing command and the left-out tests", () => {
		const text = gateFeedback(
			{
				...base,
				results: [
					{ command: "npm test", exitCode: 0, output: "ok" },
					{ command: "npm run typecheck", exitCode: 2, output: "TS2345 at test/x.test.ts:17" },
				],
			},
			["test/ui.test.ts"],
		);
		expect(text).toMatch(/Failing command: npm run typecheck \(exit code 2\)\nTS2345/);
		expect(text).toMatch(/Left out because their slices aren't integrated yet: test\/ui\.test\.ts/);
		expect(text).toMatch(/propose_contract_change/);
	});

	it("explains a merge conflict with the base", () => {
		expect(gateFeedback({ ...base, mergeConflict: ["src/a.ts"] }, [])).toMatch(/conflicts in src\/a\.ts/);
	});
});
