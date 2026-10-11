import { Language, Parser, Query } from "web-tree-sitter";
// Every .wasm import is a precompiled WebAssembly.Module (wrangler's default CompiledWasm rule): Workers forbid
// compiling wasm from bytes at run time. The core comes from the package, so it always matches its JS.
import coreWasm from "web-tree-sitter/web-tree-sitter.wasm";
import typescriptWasm from "./wasm/tree-sitter-typescript.wasm";
import tsxWasm from "./wasm/tree-sitter-tsx.wasm";
import javascriptWasm from "./wasm/tree-sitter-javascript.wasm";
import { JAVASCRIPT_QUERY, TYPESCRIPT_QUERY } from "./queries";

export type Lang = "typescript" | "tsx" | "javascript";
export type Engine = { parser: Parser; query: Query };

const GRAMMARS: Record<Lang, [WebAssembly.Module, string]> = {
	typescript: [typescriptWasm, TYPESCRIPT_QUERY],
	// TSX has the same node types as TypeScript, so the same query.
	tsx: [tsxWasm, TYPESCRIPT_QUERY],
	javascript: [javascriptWasm, JAVASCRIPT_QUERY],
};

let core: Promise<void> | null = null;
const engines = new Map<Lang, Engine>();

function initCore(): Promise<void> {
	core ??= (async () => {
		// nodejs_compat gives workerd a process.versions.node, so Emscripten's glue takes its Node path and calls
		// createRequire(import.meta.url), which is undefined in a bundled Worker. The glue skips that path when
		// process.type is "renderer" (Electron's flag), so it is set for the duration of init only. This depends on
		// one line of the generated glue (ENVIRONMENT_IS_NODE); web-tree-sitter is pinned and the workerd test
		// (npm run test:workerd) catches a change.
		const proc = (globalThis as { process?: { type?: string } }).process;
		const had = proc !== undefined && Object.hasOwn(proc, "type");
		const old = proc?.type;
		if (proc) proc.type = "renderer";
		try {
			await Parser.init({
				instantiateWasm(
					imports: WebAssembly.Imports,
					receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
				) {
					const instance = new WebAssembly.Instance(coreWasm, imports);
					receive(instance, coreWasm); // Emscripten's order: (instance, module)
					return instance.exports;
				},
			});
		} catch (err) {
			// A failed init may pass next time; don't keep the rejection.
			core = null;
			throw err;
		} finally {
			if (proc) {
				if (had) proc.type = old;
				else delete proc.type;
			}
		}
	})();
	return core;
}

/**
 * The parser and declarations query for a language. The core loads on first use and each grammar on its first
 * file, so a batch of .ts files never pays for TSX or JavaScript.
 */
export async function engine(lang: Lang): Promise<Engine> {
	await initCore();
	let found = engines.get(lang);
	if (!found) {
		const [module, scm] = GRAMMARS[lang];
		// Never Language.load(bytes): it compiles from bytes, which Workers forbid.
		const language = Language.loadSync(module);
		const parser = new Parser();
		parser.setLanguage(language);
		found = { parser, query: new Query(language, scm) };
		engines.set(lang, found);
	}
	return found;
}
