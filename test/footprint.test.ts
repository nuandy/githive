import { afterEach, describe, expect, it, vi } from "vitest";
import {
	alteredNames,
	fileFacts,
	importedName,
	MAX_PARSE_CHARS,
	MAX_USE_LINES,
	NO_FILE,
	usesOf,
	usesOfAltered,
	type FileFacts,
} from "../src/footprint";
import { SETTINGS } from "./helpers/footprints";

// Footprints: what a file declares and uses, and which exported names a change alters. Ported from
// artifact-submission's reader tests, without git: each case compares two versions of a file's text.

async function facts(path: string, source: string): Promise<FileFacts> {
	const got = await fileFacts(path, source);
	if (!got) throw new Error(`${path} didn't parse`);
	return got;
}

const altered = async (path: string, before: string, after: string) =>
	alteredNames(await facts(path, before), await facts(path, after));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("footprints: declarations and what a change alters", () => {
	it("tells body changes from interface changes in TypeScript", async () => {
		const before = await facts("src/settings.ts", SETTINGS);
		expect(before.declarations).toEqual([
			{
				name: "Settings",
				kind: "interface",
				exported: true,
				signature: "export interface Settings { timeout: number }",
			},
			{
				name: "loadSettings",
				kind: "function",
				exported: true,
				signature: "export function loadSettings(path: string): Settings",
			},
			{ name: "Store", kind: "class", exported: true, signature: "export class Store" },
			{ name: "Store.get", kind: "method", exported: true, signature: "get(key: string): string", member: true },
			{ name: "Store.cache", kind: "field", exported: false, signature: "private cache", member: true },
			{ name: "total", kind: "function", exported: true, signature: "export function total(xs: number[])" },
		]);
		const after = SETTINGS.replace("return { timeout: path.length };", "return { timeout: path.length * 2 };")
			.replace("get(key: string): string {", "get(key: string, fallback?: string): string {")
			.replace("private cache = new Map<string, string>();", "private cache = new Map<string, number>();")
			.concat("export function saveSettings(s: Settings): void {}\n");
		// loadSettings's body changed, saveSettings is new and cache is private: only Store.get's interface counts.
		expect(alteredNames(before, await facts("src/settings.ts", after))).toEqual([
			{
				name: "Store.get",
				change: "interface",
				before: "get(key: string): string",
				after: "get(key: string, fallback?: string): string",
			},
		]);
	});

	it("counts a return type change as an interface change, ignoring whitespace and comments", async () => {
		const after = SETTINGS.replace(
			"export function loadSettings(path: string): Settings {",
			"export function loadSettings(\n  path: string, // where to read from\n): Result<Settings> {",
		).replace("export interface Settings { timeout: number }", "export interface Settings {\n  timeout: number\n}");
		expect(await altered("src/settings.ts", SETTINGS, after)).toEqual([
			{
				name: "loadSettings",
				change: "interface",
				before: "export function loadSettings(path: string): Settings",
				after: "export function loadSettings( path: string, ): Result<Settings>",
			},
		]);
		// Only comments, whitespace and a trailing comma moved: no interface changed.
		const reformatted = SETTINGS.replace(
			"export function loadSettings(path: string): Settings {",
			"export function loadSettings(\n  path: string, /* a file */\n): Settings {",
		).replace("get(key: string): string {", "get(\n    key: string,\n  ): string {");
		expect(await altered("src/settings.ts", SETTINGS, reformatted)).toEqual([]);
	});

	it("counts a rename as removed plus added, for declarations and files", async () => {
		expect(await altered("src/settings.ts", SETTINGS, SETTINGS.replace("loadSettings", "readSettings"))).toEqual([
			{ name: "loadSettings", change: "removed", before: "export function loadSettings(path: string): Settings" },
		]);
		// A renamed file: the old path loses every exported name, the new one only adds.
		const old = await facts("src/old.ts", "export const a = 1;\nconst hidden = 2;\n");
		expect(alteredNames(old, NO_FILE)).toEqual([{ name: "a", change: "removed", before: "export const a" }]);
		expect(alteredNames(NO_FILE, await facts("src/new.ts", "export const a = 1;\n"))).toEqual([]);
	});

	it("reports an export toggle, by export list or keyword, whichever way it goes", async () => {
		const listed = "function foo(a: number): number {\n  return a;\n}\n\nexport { foo };\n";
		const unlisted = listed.replace("\nexport { foo };\n", "");
		const sig = "function foo(a: number): number";
		expect(await altered("src/a.ts", listed, unlisted)).toEqual([
			{ name: "foo", change: "no longer exported", before: sig, after: sig },
		]);
		expect(await altered("src/a.ts", unlisted, listed)).toEqual([
			{ name: "foo", change: "now exported", before: sig, after: sig },
		]);
		expect(await altered("src/a.ts", `export ${unlisted}`, unlisted)).toEqual([
			{ name: "foo", change: "no longer exported", before: `export ${sig}`, after: sig },
		]);
		// A toggle that also changes the signature is still a toggle, and shows both.
		expect(await altered("src/a.ts", listed, unlisted.replace("foo(a: number)", "foo(a: string)"))).toEqual([
			{ name: "foo", change: "no longer exported", before: sig, after: "function foo(a: string): number" },
		]);
		// Names that were never exported say nothing, whatever happens to them.
		expect(await altered("src/a.ts", unlisted, unlisted.replace("foo(a: number)", "foo(a: string)"))).toEqual([]);
	});

	it("counts only top-level exports and members of top-level classes: not a declare module, a namespace or a nested class", async () => {
		const src = [
			"export function load(): void {}",
			"",
			'declare module "./plugin" {',
			"  export function load(): number;",
			"}",
			"",
			"namespace N1 { export function f(): void {} }",
			"namespace N2 { export function f(): void {} }",
			"",
			"export function make() {",
			"  return class Inner { get(): number { return 1; } };",
			"}",
			"",
		].join("\n");
		const after = src
			.replace("export function load(): number;", "export function load(x: string): number;")
			.replace("N2 { export function f(): void {}", "N2 { export function f(): number { return 1; }")
			.replace("get(): number { return 1; }", "get(x: string): number { return 1; }");
		expect(await altered("src/a.ts", src, after)).toEqual([]);
	});

	it("tells members apart: private ones say nothing, and a class removed or unexported speaks for its members", async () => {
		const store =
			"export class Store {\n  get(key: string): string { return key; }\n  private put(key: string): void {}\n  #hidden = 1;\n  size = 0;\n}\n";
		const reshaped = store
			.replace("put(key: string)", "put(key: number)")
			.replace("#hidden = 1", "#hidden = 'x'")
			.replace("size = 0", "size: number = 0");
		expect(await altered("src/store.ts", store, reshaped)).toEqual([
			{ name: "Store.size", change: "interface", before: "size", after: "size: number" },
		]);
		expect(await altered("src/store.ts", store, "export const other = 1;\n")).toEqual([
			{ name: "Store", change: "removed", before: "export class Store" },
		]);
		expect(await altered("src/store.ts", store, store.replace("export class", "class"))).toEqual([
			{ name: "Store", change: "no longer exported", before: "export class Store", after: "class Store" },
		]);
		// A member made private is no longer exported, though its class still is.
		expect(await altered("src/store.ts", store, store.replace("  get(", "  private get("))).toEqual([
			{
				name: "Store.get",
				change: "no longer exported",
				before: "get(key: string): string",
				after: "private get(key: string): string",
			},
		]);
	});

	it("reads JavaScript, JSX and TSX, where a function value makes a function", async () => {
		const js = await facts(
			"src/fmt.js",
			"export const fmt = (n) => n.toFixed(2);\nconst local = () => 1;\nexport class A { #x = 1; y = 2; run() {} }\n",
		);
		expect(js.declarations).toEqual([
			{ name: "fmt", kind: "function", exported: true, signature: "export const fmt = (n) =>" },
			{ name: "local", kind: "function", exported: false, signature: "const local = () =>" },
			{ name: "A", kind: "class", exported: true, signature: "export class A" },
			{ name: "A.#x", kind: "field", exported: false, signature: "#x", member: true },
			{ name: "A.y", kind: "field", exported: true, signature: "y", member: true },
			{ name: "A.run", kind: "method", exported: true, signature: "run()", member: true },
		]);
		const jsx = await facts(
			"src/App.jsx",
			'import { Button } from "./Button";\nexport function App() {\n  return <Button label="x" />;\n}\n',
		);
		expect(jsx.imports[0]!.names).toEqual([{ imported: "Button", local: "Button", uses: [3] }]);
		const tsx = await facts(
			"src/App.tsx",
			"export function App(props: { n: number }): JSX.Element {\n  return <div>{props.n}</div>;\n}\n",
		);
		expect(tsx.declarations.map((d) => d.signature)).toEqual([
			"export function App(props: { n: number }): JSX.Element",
		]);
		for (const ext of ["mjs", "cjs", "mts", "cts"])
			expect(await fileFacts(`src/a.${ext}`, "export const a = 1;\n")).not.toBeNull();
	});

	it('marks the default export, which importers name "default"', async () => {
		const before = await facts(
			"src/App.tsx",
			"export default function App(props: { n: number }) {\n  return null;\n}\n",
		);
		expect(before.declarations).toEqual([
			{
				name: "App",
				kind: "function",
				exported: true,
				signature: "export default function App(props: { n: number })",
				default: true,
			},
		]);
		const changes = alteredNames(
			before,
			await facts("src/App.tsx", "export default function App(props: { n: string }) {\n  return null;\n}\n"),
		);
		expect(changes).toEqual([
			{
				name: "App",
				change: "interface",
				before: "export default function App(props: { n: number })",
				after: "export default function App(props: { n: string })",
				default: true,
			},
		]);
		expect(importedName(changes[0]!)).toBe("default");
		const listed = await facts("src/b.ts", "class Store { get(): void {} }\nexport default Store;\n");
		expect(listed.declarations.every((d) => d.default && d.exported)).toBe(true);
		expect(importedName({ name: "Store.get" })).toBe("Store");
	});

	it("keeps files that don't parse, other languages and huge files out, and never throws", async () => {
		const broken = SETTINGS.replace("export function total(xs: number[]) {", "export function total(xs: number[] {");
		expect(await fileFacts("src/settings.ts", broken)).toBeNull();
		expect(await fileFacts("README.md", "# demo\n")).toBeNull();
		expect(await fileFacts("src/blob.ts", "\u0000\u0001�{{{")).toBeNull();
		// Not knowing one side is not a change.
		const good = await facts("src/settings.ts", SETTINGS);
		expect(alteredNames(good, null)).toEqual([]);
		expect(alteredNames(null, good)).toEqual([]);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await fileFacts("src/huge.ts", `export const a = 1;\n${" ".repeat(MAX_PARSE_CHARS)}`)).toBeNull();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped src/huge.ts"));
	});

	it("cuts signatures right in files with non-ASCII text", async () => {
		const f = await facts(
			"src/a.ts",
			'const s = "héllo 🎉";\nexport function f(a: string /* ç */, b = "é"): void {}\n',
		);
		expect(f.declarations[1]!.signature).toBe('export function f(a: string , b = "é"): void');
	});

	it("switches grammars from file to file", async () => {
		const ts = await facts("src/a.ts", "export function a(x: number): number { return x; }\n");
		const js = await facts("src/b.js", "export function b(x) { return x; }\n");
		const again = await facts("src/c.ts", "export function c(x: string): string { return x; }\n");
		expect([ts, js, again].map((f) => f.declarations[0]!.signature)).toEqual([
			"export function a(x: number): number",
			"export function b(x)",
			"export function c(x: string): string",
		]);
	});
});

describe("footprints: imports and their uses", () => {
	it("records each imported name with the lines that use it, resolved relative to the file", async () => {
		const sync = [
			'import { loadSettings } from "../settings";',
			'import * as s from "../settings";',
			'import type { Settings as Config } from "../settings";',
			'import React from "react";',
			'import "./side-effect";',
			"",
			"export function sync(c: Config) {",
			'  const a = loadSettings("x");',
			"  const b = new s.Store();",
			"  return [a.timeout, s, React];",
			"}",
			"",
		].join("\n");
		const f = await facts("src/jobs/sync.ts", sync);
		expect(f.imports).toEqual([
			{
				from: "../settings",
				resolved: "src/settings",
				names: [{ imported: "loadSettings", local: "loadSettings", uses: [8] }],
			},
			{
				from: "../settings",
				resolved: "src/settings",
				names: [],
				namespace: {
					local: "s",
					uses: [
						{ name: "Store", lines: [9] },
						{ name: "*", lines: [10] },
					],
				},
			},
			{ from: "../settings", resolved: "src/settings", names: [{ imported: "Settings", local: "Config", uses: [7] }] },
			{ from: "react", names: [{ imported: "default", local: "React", uses: [10] }] },
			{ from: "./side-effect", resolved: "src/jobs/side-effect", names: [] },
		]);
		expect(usesOf(f, "src/settings.ts")).toEqual([
			{ file: "src/settings.ts", name: "loadSettings", lines: [8] },
			{ file: "src/settings.ts", name: "Store", lines: [9] },
			{ file: "src/settings.ts", name: "*", lines: [10] },
			{ file: "src/settings.ts", name: "Settings", lines: [7] },
		]);
		// An index file is a candidate too; another file or a package never is.
		expect(usesOf(f, "src/settings/index.ts")).toHaveLength(4);
		expect(usesOf(f, "src/settings.json")).toEqual([]);
		expect(usesOf(f, "src/jobs/settings.ts")).toEqual([]);
	});

	it("matches altered names to uses by imported name: a member by its class, anything through a whole namespace", async () => {
		const f = await facts(
			"src/jobs/a.ts",
			'import { Store } from "../store";\nimport cfg from "../config";\nimport * as all from "../store";\nnew Store().get("k");\nf(cfg, all);\n',
		);
		const store = usesOf(f, "src/store.ts");
		expect(usesOfAltered({ name: "Store.get", change: "interface" }, store)).toEqual([
			{ file: "src/store.ts", name: "Store", lines: [4] },
			{ file: "src/store.ts", name: "*", lines: [5] },
		]);
		expect(usesOfAltered({ name: "other", change: "removed" }, store)).toEqual([
			{ file: "src/store.ts", name: "*", lines: [5] },
		]);
		const config = usesOf(f, "src/config.js");
		expect(usesOfAltered({ name: "load", change: "removed", default: true }, config)).toEqual([
			{ file: "src/config.js", name: "default", lines: [5] },
		]);
	});

	it("keeps at most MAX_USE_LINES lines per name", async () => {
		const body = Array.from({ length: MAX_USE_LINES + 5 }, () => "go();").join("\n");
		const f = await facts("src/a.ts", `import { go } from "./go";\n${body}\n`);
		expect(f.imports[0]!.names[0]!.uses).toEqual(Array.from({ length: MAX_USE_LINES }, (_, i) => i + 2));
	});

	it("reads TypeScript's import-require as a whole-module import", async () => {
		const f = await facts("src/a.ts", 'import cfg = require("./config");\nexport const t = cfg.timeout;\n');
		expect(f.imports).toEqual([
			{
				from: "./config",
				resolved: "src/config",
				names: [],
				namespace: { local: "cfg", uses: [{ name: "timeout", lines: [2] }] },
			},
		]);
	});
});

describe("footprints: uses respect scope", () => {
	const head = 'import { loadSettings, Store, Settings } from "../settings";\n\n';
	const uses = async (body: string) => {
		const f = await facts("src/jobs/a.ts", head + body);
		return usesOf(f, "src/settings.ts").flatMap((u) => u.lines.map((l) => `${u.name}@${l}`));
	};

	it("does not count parameters, locals or type parameters that shadow an import", async () => {
		expect(await uses("function f(loadSettings: number) {\n  return loadSettings + 1;\n}\n")).toEqual([]);
		expect(await uses("function g() {\n  const Store = 1;\n  return Store;\n}\n")).toEqual([]);
		expect(await uses("function h<Settings>(x: Settings) {\n  return x;\n}\n")).toEqual([]);
		expect(await uses("const k = ({ Store }: any, [loadSettings]: any[]) => Store + loadSettings;\n")).toEqual([]);
		expect(await uses("try {\n  go();\n} catch (Store) {\n  log(Store);\n}\n")).toEqual([]);
		expect(await uses("for (const Store of xs) {\n  log(Store);\n}\n")).toEqual([]);
		expect(await uses("function v() {\n  if (x) { var Store = 1; }\n  return Store;\n}\n")).toEqual([]);
	});

	it("still counts a sibling scope that uses the import", async () => {
		const got = await uses(
			'function f(loadSettings: number) {\n  return loadSettings;\n}\nfunction g() {\n  return loadSettings("x");\n}\n',
		);
		expect(got).toEqual(["loadSettings@7"]);
	});

	it("counts types, shorthand properties and re-exports, but not property names", async () => {
		const got = await uses(
			"export function f(s: Settings): Store {\n  const o = { loadSettings, x: other.loadSettings };\n  return o as never;\n}\nexport { Store };\n",
		);
		expect(got).toEqual(["loadSettings@4", "Store@3", "Store@7", "Settings@3"]);
	});
});
