import { describe, expect, it } from "vitest";
import {
	alteredNames,
	fileFacts,
	headsUpNext,
	headsUpSays,
	headsUpUsedNext,
	headsUpUsedSays,
	interfaceNext,
	interfaceSays,
	useFact,
	usesOf,
	usesOfAltered,
	useSays,
	type AlteredName,
	type UseFact,
} from "../src/footprint";
import { SETTINGS_TS, SIGNATURE_CHANGE, USES_LOAD } from "./helpers/footprints";

// The says and next lines of interface and heads_up notices (docs/awareness.md, section 7).

const BEFORE = "export function loadSettings(path: string): Settings";
const AFTER = "export function loadSettings(path: string): Result<Settings>";
const at = [{ file: "src/jobs/sync.ts", line: 4 }];
const fact = (altered: AlteredName, more: Partial<UseFact> = {}): UseFact => ({
	file: "src/config.ts",
	altered,
	imported: altered.name,
	at,
	...more,
});
const ALICE = { by: "alice", change: "c-7", commit: "1a2b3c4d5e6f", intent: "return a Result from loadSettings" };

describe("footprints: interface notices", () => {
	it("says what docs/awareness.md says, from the parsed files to the line", async () => {
		const altered = alteredNames(
			await fileFacts("src/config.ts", SETTINGS_TS),
			await fileFacts("src/config.ts", SIGNATURE_CHANGE),
		);
		const sync = await fileFacts("src/jobs/sync.ts", USES_LOAD);
		const facts = altered.map((a) =>
			useFact("src/config.ts", a, usesOfAltered(a, usesOf(sync!, "src/config.ts")), "src/jobs/sync.ts"),
		);
		expect(interfaceSays(ALICE, facts)).toBe(
			'alice landed c-7 ("return a Result from loadSettings"): your change imports `loadSettings` from ' +
				"`src/config.ts` and uses it at `src/jobs/sync.ts:4`; its interface changed from " +
				"`export function loadSettings(path: string): Settings` to " +
				"`export function loadSettings(path: string): Result<Settings>`",
		);
		expect(interfaceNext("main")).toBe(
			"Merge the branch into yours and update those uses before you merge: git fetch origin main && git merge origin/main.",
		);
	});

	it("words a removal, both export toggles, and a member", () => {
		expect(useSays(fact({ name: "loadSettings", change: "removed", before: BEFORE }))).toBe(
			"your change imports `loadSettings` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; it was removed " +
				"(`export function loadSettings(path: string): Settings`)",
		);
		expect(useSays(fact({ name: "loadSettings", change: "no longer exported", before: BEFORE, after: BEFORE }))).toBe(
			"your change imports `loadSettings` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; it is no longer exported",
		);
		expect(useSays(fact({ name: "loadSettings", change: "now exported", before: BEFORE, after: BEFORE }))).toBe(
			"your change imports `loadSettings` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; it is now exported",
		);
		const get = {
			name: "Store.get",
			change: "interface" as const,
			before: "get(key: string): string",
			after: "get(key: number): string",
		};
		expect(useSays(fact(get, { imported: "Store" }))).toBe(
			"your change imports `Store` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; `Store.get` changed from " +
				"`get(key: string): string` to `get(key: number): string`",
		);
		expect(useSays(fact({ ...get, change: "removed" }, { imported: "Store" }))).toContain(
			"; `Store.get` was removed (`get(key: string): string`)",
		);
	});

	it("names a namespace and a default import, and a commit GitHive didn't make by its author", () => {
		const removed = { name: "loadSettings", change: "removed" as const, before: BEFORE };
		expect(useSays(fact(removed, { imported: "*" }))).toBe(
			"your change imports all of `src/config.ts` and uses it at `src/jobs/sync.ts:4`; `loadSettings` was removed " +
				"(`export function loadSettings(path: string): Settings`)",
		);
		expect(useSays(fact({ ...removed, default: true }, { imported: "default" }))).toContain(
			"your change imports the default export of `src/config.ts` and uses it at",
		);
		expect(interfaceSays({ by: "Jane Doe", commit: "9f8e7d6c5b4a" }, [fact(removed)])).toMatch(
			/^Jane Doe pushed 9f8e7d6: your change imports/,
		);
		expect(interfaceSays({ by: "Jane Doe", commit: "9f8e7d6c5b4a", intent: "Tidy config" }, [fact(removed)])).toMatch(
			/^Jane Doe pushed 9f8e7d6 \("Tidy config"\): /,
		);
	});

	it("joins several names, and keeps long lists and signatures short", () => {
		const a = fact({ name: "loadSettings", change: "removed", before: BEFORE });
		const b = fact({ name: "Settings", change: "no longer exported" }, { at: [{ file: "src/jobs/x.ts", line: 2 }] });
		expect(interfaceSays(ALICE, [a, b])).toBe(
			`${interfaceSays(ALICE, [a])}; your change imports \`Settings\` from \`src/config.ts\` and uses it at \`src/jobs/x.ts:2\`; it is no longer exported`,
		);
		const many = Array.from({ length: 7 }, (_, i) => ({ file: "src/jobs/sync.ts", line: i + 1 }));
		expect(useSays(fact({ name: "x", change: "now exported" }, { at: many }))).toContain(
			"uses it at `src/jobs/sync.ts:1`, `src/jobs/sync.ts:2`, `src/jobs/sync.ts:3`, `src/jobs/sync.ts:4`, `src/jobs/sync.ts:5`, 2 more;",
		);
		const long = `export type Big = { ${"field: string; ".repeat(40)}}`;
		const says = useSays(fact({ name: "Big", change: "removed", before: long }));
		expect(says).toContain(`(\`${long.slice(0, 199)}…\`)`);
		expect(says.length).toBeLessThan(400);
	});
});

describe("footprints: heads-ups between open changes", () => {
	const BOB = { by: "bob", change: "c-9", intent: "return a Result from loadSettings" };
	const sig = { name: "loadSettings", change: "interface" as const, before: BEFORE, after: AFTER };

	it("tells the agent whose change uses a name another open change alters", () => {
		expect(headsUpSays(BOB, [fact(sig)])).toBe(
			'bob\'s change c-9 ("return a Result from loadSettings") alters code your change uses, not landed yet: ' +
				"your change imports `loadSettings` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; their change alters " +
				"its interface from `export function loadSettings(path: string): Settings` to " +
				"`export function loadSettings(path: string): Result<Settings>`",
		);
		expect(headsUpNext(BOB)).toBe(
			"Nothing has landed yet: agree on it with a note on c-9, or update those uses once it lands.",
		);
	});

	it("tells the agent whose change alters a name another open change uses", () => {
		expect(headsUpUsedSays(BOB, [fact(sig)])).toBe(
			'bob\'s change c-9 ("return a Result from loadSettings") uses code your change alters: their change imports ' +
				"`loadSettings` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; your change alters its interface from " +
				"`export function loadSettings(path: string): Settings` to `export function loadSettings(path: string): Result<Settings>`",
		);
		expect(headsUpUsedNext(BOB)).toBe(
			"Nothing has landed yet: agree on it with a note on c-9, or keep what they use working.",
		);
	});

	it("words removals, toggles and members from both sides", () => {
		const other = { by: "carol", change: "c-3" };
		const removed = fact({ name: "loadSettings", change: "removed", before: BEFORE });
		expect(headsUpSays(other, [removed])).toBe(
			"carol's change c-3 alters code your change uses, not landed yet: your change imports `loadSettings` from " +
				"`src/config.ts` and uses it at `src/jobs/sync.ts:4`; their change removes it " +
				"(`export function loadSettings(path: string): Settings`)",
		);
		expect(headsUpUsedSays(other, [fact({ name: "loadSettings", change: "no longer exported" })])).toMatch(
			/; your change stops exporting it$/,
		);
		expect(headsUpSays(other, [fact({ name: "loadSettings", change: "now exported" })])).toMatch(
			/; their change exports it$/,
		);
		expect(
			headsUpSays(other, [fact({ name: "Store.get", change: "removed", before: "get()" }, { imported: "Store" })]),
		).toMatch(/; their change removes `Store.get` \(`get\(\)`\)$/);
		expect(
			headsUpUsedSays(other, [
				fact({ name: "Store.get", change: "interface", before: "get()", after: "get(k)" }, { imported: "Store" }),
			]),
		).toMatch(/; your change alters `Store.get` from `get\(\)` to `get\(k\)`$/);
	});
});
