import { describe, expect, it } from "vitest";
import { importTargets, relativeTarget, resolveImport, resolvesTo } from "../src/footprint";

// Relative import specifiers, resolved to repo paths (ported from artifact-submission's resolver tests).

describe("footprints: resolving relative imports", () => {
	const resolver = (files: string[]) => {
		const set = new Set(files);
		return (from: string, spec: string) => resolveImport(from, spec, (p) => set.has(p));
	};

	it("resolves relative paths with extensions, .js written for .ts, and index files", () => {
		const resolve = resolver(["src/a.ts", "src/b.tsx", "src/c.d.ts", "src/lib/index.ts", "src/m.mts", "index.js"]);
		expect(resolve("src/x.ts", "./a")).toBe("src/a.ts");
		expect(resolve("src/x.ts", "./a.js")).toBe("src/a.ts");
		expect(resolve("src/x.ts", "./b")).toBe("src/b.tsx");
		expect(resolve("src/x.ts", "./c")).toBe("src/c.d.ts");
		expect(resolve("src/x.ts", "./lib")).toBe("src/lib/index.ts");
		expect(resolve("src/x.ts", "./m.mjs")).toBe("src/m.mts");
		expect(resolve("src/deep/x.ts", "../a")).toBe("src/a.ts");
		expect(resolve("src/x.ts", "..")).toBe("index.js");
		expect(resolve("src/x.ts", "../../outside")).toBeNull();
		expect(resolve("src/x.ts", "./missing")).toBeNull();
		expect(resolve("src/x.ts", "react")).toBeNull();
		expect(resolve("src/x.ts", "/etc/passwd")).toBeNull();
	});

	it("names the target without the tree, and says which files it may be", () => {
		expect(relativeTarget("src/jobs/sync.ts", "../settings")).toBe("src/settings");
		expect(relativeTarget("src/jobs/sync.ts", "./a/../b.js")).toBe("src/jobs/b.js");
		expect(relativeTarget("a.ts", "./b")).toBe("b");
		expect(relativeTarget("a.ts", ".")).toBe("");
		expect(relativeTarget("src/a.ts", "../../x")).toBeNull();
		expect(relativeTarget("src/a.ts", "@/x")).toBeNull();
		expect(importTargets("src/a.js").slice(0, 4)).toEqual(["src/a.js", "src/a.ts", "src/a.tsx", "src/a.js.ts"]);
		expect(importTargets("")).toContain("index.ts");
		expect(resolvesTo("src/settings", "src/settings.ts")).toBe(true);
		expect(resolvesTo("src/settings", "src/settings/index.tsx")).toBe(true);
		expect(resolvesTo("src/settings", "src/settings-old.ts")).toBe(false);
	});
});
