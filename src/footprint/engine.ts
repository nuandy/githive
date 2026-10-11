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
/** The parser's linear memory, once it has started: 32 MiB at first, and it grows, never shrinks, with big inputs. */
let memory: WebAssembly.Memory | undefined;

// What failed to load, and in which batch: a grammar or the core that failed is tried again at most once a batch
// (see newParseBatch), not on every file, which would spend a batch's CPU on failing loads.
let batch = 0;
const failedIn = new Map<Lang | "core", number>();

/** Starts a batch of parsing: what failed to load in an earlier batch is tried once more. */
export function newParseBatch() {
	batch++;
}

/** How big the parser's memory is now, in bytes, or null before it starts. */
export function parserMemoryBytes(): number | null {
	return memory ? memory.buffer.byteLength : null;
}

/** What engine throws for a grammar or core that failed to load in this batch, logged once: the file is skipped. */
export class NotLoaded extends Error {}

// Throws at once if `what` failed to load in this batch; otherwise loads it, noting a failure.
async function once<T>(what: Lang | "core", load: () => T | Promise<T>): Promise<T> {
	if (failedIn.get(what) === batch)
		throw new NotLoaded(`${what === "core" ? "the parser" : what} failed to load in this batch`);
	try {
		return await load();
	} catch (err) {
		failedIn.set(what, batch);
		const said = `${what === "core" ? "the parser" : `the ${what} grammar`} failed to load: ${String(err)}`;
		console.error(`footprint: ${said}`);
		throw new NotLoaded(said);
	}
}

function initCore(): Promise<void> {
	core ??= (async () => {
		// nodejs_compat gives workerd a process.versions.node, so Emscripten's glue takes its Node path and calls
		// createRequire(import.meta.url), which is undefined in a bundled Worker. The glue skips that path when
		// process.type is "renderer" (Electron's flag), so it is set for the duration of init only. This depends on
		// one line of the generated glue (ENVIRONMENT_IS_NODE); web-tree-sitter is pinned and the workerd test
		// (npm run test:workerd) catches a change.
		// Nothing else in GitHive reads process.type, and the init takes a few milliseconds, during which other requests
		// in the isolate see it too.
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
					memory = (imports.env as { memory?: WebAssembly.Memory } | undefined)?.memory;
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
	await once("core", initCore);
	let found = engines.get(lang);
	if (!found) {
		const [module, scm] = GRAMMARS[lang];
		found = await once(lang, () => {
			// Never Language.load(bytes): it compiles from bytes, which Workers forbid.
			const language = Language.loadSync(module);
			const parser = new Parser();
			parser.setLanguage(language);
			return { parser, query: new Query(language, scm) };
		});
		engines.set(lang, found);
	}
	return found;
}
