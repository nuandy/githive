import { describe, expect, it } from "vitest";
import type { LandedChange } from "../api";
import { batchesOf, lastChangeTo } from "./landed";

const landed = (change: string, files: string[], at?: string): LandedChange => ({
	commit: `${change}-merge`,
	change,
	agent: "agent",
	head: `${change}-head`,
	title: `Do ${change}`,
	files,
	reviews: [],
	...(at ? { at } : {}),
});

// Newest first, as History lists them.
const changes = [
	landed("prices", ["src/lib/format.ts", "src/lib/currency.ts"], "2026-10-13T14:02:00.000Z"),
	landed("tax", ["src/lib/currency.ts"], "2026-10-13T14:02:00.000Z"),
	landed("cache", ["src/pages/Category.tsx"], "2026-10-13T11:40:00.000Z"),
	landed("seed", ["scripts/seed.ts", "src/lib/format.ts"]),
	landed("prettier", [".prettierrc"]),
];

describe("the last change to a file", () => {
	it("is the newest landed change that touched it", () => {
		expect(lastChangeTo("src/lib/currency.ts", changes)?.change).toBe("prices");
		expect(lastChangeTo("scripts/seed.ts", changes)?.change).toBe("seed");
		expect(lastChangeTo("src/lib/format.ts", changes.slice(1))?.change).toBe("seed");
		expect(lastChangeTo("README.md", changes)).toBeUndefined();
		expect(lastChangeTo("src/lib", changes)).toBeUndefined();
	});
});

describe("changes landed together", () => {
	it("are those next to each other that landed at the same moment, as one batch lands", () => {
		expect(batchesOf(changes).map((batch) => [batch.at, batch.changes.map((change) => change.change)])).toEqual([
			["2026-10-13T14:02:00.000Z", ["prices", "tax"]],
			["2026-10-13T11:40:00.000Z", ["cache"]],
			[undefined, ["seed"]],
			[undefined, ["prettier"]],
		]);
	});
});
