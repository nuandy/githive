import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { alteredNames, fileFacts } from "../../src/footprint";
import { SETTINGS, SETTINGS_TS, SIGNATURE_CHANGE } from "../helpers/footprints";

// The footprint parser in workerd, which (unlike Node) refuses to compile wasm from bytes at run time: a
// regression to Language.load(bytes) or a fetched core fails here, not in production.

describe("footprints in workerd", () => {
	it("refuses to compile wasm from bytes, so the tests below prove the parser doesn't", () => {
		// The smallest valid module: the magic number and version. Workers' types forbid the constructor outright.
		const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
		const Module = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;
		expect(() => new Module(empty)).toThrow(/disallowed/);
	});

	it("parses TypeScript, TSX and JavaScript and tells an interface change", async () => {
		const before = await fileFacts("src/config.ts", SETTINGS_TS);
		const after = await fileFacts("src/config.ts", SIGNATURE_CHANGE);
		expect(alteredNames(before, after)).toEqual([
			{
				name: "loadSettings",
				change: "interface",
				before: "export function loadSettings(path: string): Settings",
				after: "export function loadSettings(path: string): Result<Settings>",
			},
		]);
		const tsx = await fileFacts("src/App.tsx", "export function App(): JSX.Element {\n  return <div />;\n}\n");
		expect(tsx?.declarations.map((d) => d.name)).toEqual(["App"]);
		const js = await fileFacts("src/a.mjs", 'import { a } from "./b.js";\nexport const c = () => a;\n');
		expect(js?.imports).toEqual([
			{ from: "./b.js", resolved: "src/b.js", names: [{ imported: "a", local: "a", uses: [2] }] },
		]);
	});

	// The same Worker twice: through the test runner, and bundled by wrangler exactly as for a deploy (where
	// import.meta.url is undefined, so the engine's process.type workaround matters).
	const workers: [string, () => Fetcher][] = [
		["the test runner", () => (exports as unknown as { default: Fetcher }).default],
		["wrangler's bundle", () => (env as unknown as { BUNDLED: Fetcher }).BUNDLED],
	];
	for (const [how, worker] of workers) {
		it(`answers through a Worker's fetch handler, loaded by ${how}`, async () => {
			const after = SETTINGS.replace("loadSettings", "readSettings");
			const res = await worker().fetch("https://footprint.test/", {
				method: "POST",
				body: JSON.stringify({ path: "src/settings.ts", before: SETTINGS, after }),
			});
			const body = await res.json<{ altered: unknown }>();
			expect(body.altered).toEqual([
				{ name: "loadSettings", change: "removed", before: "export function loadSettings(path: string): Settings" },
			]);
		});
	}
});
