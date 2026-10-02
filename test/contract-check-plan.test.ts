import { describe, expect, it } from "vitest";
import { contractErrors, contractGroups, describeError, jsContracts, nearestConfig, parseNodeCheck, parseTsc } from "../src/contract-check-plan";

const configs = ["tsconfig.json", "web/tsconfig.json"];

describe("nearestConfig", () => {
	it("walks up to the closest tsconfig", () => {
		expect(nearestConfig("web/contracts/data.test.ts", configs)).toBe("web/tsconfig.json");
		expect(nearestConfig("test/x.test.ts", configs)).toBe("tsconfig.json");
		expect(nearestConfig("x.ts", ["web/tsconfig.json"])).toBeNull();
	});
});

describe("contractGroups", () => {
	it("groups TypeScript contracts by config, relative to its directory", () => {
		const { groups, unchecked } = contractGroups(
			["web/src/contract.ts", "web/contracts/data.test.ts", "test/api.test.ts", "docs/notes.md"],
			configs,
		);
		expect(groups.get("web/tsconfig.json")).toEqual(["src/contract.ts", "contracts/data.test.ts"]);
		expect(groups.get("tsconfig.json")).toEqual(["test/api.test.ts"]);
		expect(unchecked).toEqual([]);
	});
});

describe("parseTsc and contractErrors", () => {
	const output = [
		"web/contracts/data.test.ts(12,3): error TS1005: '}' expected.",
		"web/contracts/data.test.ts(2,30): error TS2307: Cannot find module '../src/lib/dashboardData' or its corresponding type declarations.",
		"web/src/contract.ts(20,17): error TS2391: Function implementation is missing or not immediately following the declaration.",
		"test/events.test.ts(17,70): error TS2345: Argument of type '\"created\"' is not assignable to parameter of type 'TaskEventType | undefined'.",
		"src/other.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
	].join("\n");

	it("keeps real mistakes in contract files and drops expected missing-module errors", () => {
		const errors = contractErrors(parseTsc(output), ["web/contracts/data.test.ts", "web/src/contract.ts", "test/events.test.ts"]);
		expect(errors.map((e) => `${e.file}:${e.line} TS${e.code}`)).toEqual([
			"web/contracts/data.test.ts:12 TS1005",
			"web/src/contract.ts:20 TS2391",
			"test/events.test.ts:17 TS2345",
		]);
	});
});

describe("JavaScript contracts", () => {
	it("checks plain JavaScript but not JSX", () => {
		expect(jsContracts(["a.js", "b.mjs", "c.cjs", "d.jsx", "e.ts"])).toEqual(["a.js", "b.mjs", "c.cjs"]);
	});

	it("parses a node --check syntax error", () => {
		const output = "/work/src/contract.js:3\n  return {\n         ^\n\nSyntaxError: Unexpected end of input\n    at checkSyntax (node:internal/main/check_syntax:75:5)";
		expect(parseNodeCheck("src/contract.js", output)).toEqual({
			file: "src/contract.js",
			line: 3,
			code: 0,
			message: "SyntaxError: Unexpected end of input",
		});
		expect(parseNodeCheck("src/contract.js", "")).toBeNull();
	});

	it("describes TypeScript and JavaScript errors", () => {
		expect(describeError({ file: "a.ts", line: 2, code: 2391, message: "m" })).toBe("a.ts:2 TS2391: m");
		expect(describeError({ file: "a.js", line: 3, code: 0, message: "SyntaxError: x" })).toBe("a.js:3 JS: SyntaxError: x");
	});
});
