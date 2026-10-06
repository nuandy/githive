import { describe, expect, it } from "vitest";
import { buildTree, listDir, pathCrumbs, pathKind } from "./tree";

const files = ["README.md", "package.json", "src/index.ts", "src/stats/page.tsx", "src/stats/data.ts", "docs/guide.md"];

describe("the file tree", () => {
	it("nests paths into folders, folders first, each by name", () => {
		const tree = buildTree(files);
		expect(tree.map((n) => [n.name, n.kind])).toEqual([
			["docs", "dir"],
			["src", "dir"],
			["package.json", "file"],
			["README.md", "file"],
		]);
		const src = tree.find((n) => n.name === "src")!;
		expect(src.children.map((n) => n.path)).toEqual(["src/stats", "src/index.ts"]);
		expect(src.children[0].children.map((n) => n.path)).toEqual(["src/stats/data.ts", "src/stats/page.tsx"]);
	});

	it("lists one folder and tells files from folders", () => {
		expect(listDir(files, "").map((n) => n.name)).toEqual(["docs", "src", "package.json", "README.md"]);
		expect(listDir(files, "src/").map((n) => [n.name, n.kind])).toEqual([
			["stats", "dir"],
			["index.ts", "file"],
		]);
		expect(pathKind(files, "")).toBe("dir");
		expect(pathKind(files, "src/stats")).toBe("dir");
		expect(pathKind(files, "src/stats/page.tsx")).toBe("file");
		expect(pathKind(files, "src/stat")).toBe("missing");
	});

	it("breaks a path into crumbs", () => {
		expect(pathCrumbs("src/stats/page.tsx")).toEqual([
			{ name: "src", path: "src" },
			{ name: "stats", path: "src/stats" },
			{ name: "page.tsx", path: "src/stats/page.tsx" },
		]);
		expect(pathCrumbs("")).toEqual([]);
	});
});
