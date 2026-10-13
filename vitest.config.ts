import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// The Worker imports .wasm as a precompiled WebAssembly.Module (wrangler's CompiledWasm rule). Node has no such
// rule, so tests get the same shape by compiling the file, which Node allows and Workers don't: the workerd tests
// (vitest.workerd.config.ts) cover the Worker's way.
const compiledWasm: Plugin = {
	name: "compiled-wasm",
	enforce: "pre",
	load(id) {
		const file = id.split("?")[0]!;
		if (file.endsWith(".wasm"))
			return `import { readFileSync } from "node:fs";\nexport default new WebAssembly.Module(readFileSync(${JSON.stringify(file)}));`;
	},
};

/** What no test run looks in. */
export const SHARED_EXCLUDES = ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", "**/.claude/**", "demo/**"];
export const SOAK = "test/soak/**";

export default defineConfig({
	plugins: [compiledWasm],
	resolve: {
		// Durable Object classes import cloudflare:workers; tests run them in Node with a stand-in.
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./test/fakes/cloudflare-workers.ts", import.meta.url)),
			// The dashboard's own alias (web/vite.config.ts), which components the shadcn CLI adds import through.
			"@": fileURLToPath(new URL("./web/src", import.meta.url)),
		},
	},
	// node:sqlite stands in for D1 in tests; Node 22 still keeps it behind a flag.
	test: {
		// test/workerd runs in workerd, through its own config (npm run test:workerd). .claude/ holds agents' own
		// worktrees, whose copies of the tests aren't this checkout's; demo/ holds the demo game's own node:test tests.
		// The soak runs (test/soak) run on their own (npm run test:soak).
		exclude: [...SHARED_EXCLUDES, "test/workerd/**", SOAK],
		execArgv: ["--experimental-sqlite", "--no-warnings=ExperimentalWarning"],
		// Run through Vite, so its cloudflare:workers import gets the stand-in above, and a package's .wasm (the
		// parser's core) gets the plugin above instead of Node instantiating it as a module.
		server: { deps: { inline: ["@cloudflare/workers-oauth-provider", /\.wasm$/] } },
	},
});
