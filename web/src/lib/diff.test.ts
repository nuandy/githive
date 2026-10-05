import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";

const unified = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,3 +1,3 @@",
	" one",
	"-two",
	"+TWO",
	" three",
	"diff --git a/src/new.ts b/src/new.ts",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/src/new.ts",
	"@@ -0,0 +1 @@",
	"+hello",
	"diff --git a/old.ts b/old.ts",
	"deleted file mode 100644",
	"--- a/old.ts",
	"+++ /dev/null",
	"@@ -1 +0,0 @@",
	"-bye",
	"",
	"[Blueprint diff notice: diff content omitted for 1 changed file because per-file or total diff limits were reached. Omitted paths: big.json]",
	"",
].join("\n");

describe("parseUnifiedDiff", () => {
	it("splits a diff into files with statuses, counts and line numbers", () => {
		const files = parseUnifiedDiff(unified);
		expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
			["src/a.ts", "modified", 1, 1],
			["src/new.ts", "added", 1, 0],
			["old.ts", "deleted", 0, 1],
		]);
		expect(files[0].lines).toEqual([
			{ type: "hunk", text: "@@ -1,3 +1,3 @@" },
			{ type: "context", text: "one", oldNo: 1, newNo: 1 },
			{ type: "del", text: "two", oldNo: 2 },
			{ type: "add", text: "TWO", newNo: 2 },
			{ type: "context", text: "three", oldNo: 3, newNo: 3 },
		]);
	});

	it("unquotes paths Git had to quote", () => {
		const files = parseUnifiedDiff('diff --git "a/my file.ts" "b/my file.ts"\n--- "a/my file.ts"\n+++ "b/my file.ts"\n@@ -1 +1 @@\n-a\n+b\n');
		expect(files[0].path).toBe("my file.ts");
	});

	it("returns nothing for an empty diff", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});
});
