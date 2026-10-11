import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests that run inside workerd (npm run test:workerd), for what Node can't check: workerd refuses to compile wasm
// from bytes, as production does. A tiny Worker of its own (test/workerd), not GitHive's wrangler.jsonc.
//
// The test runner loads modules its own way (import.meta.url is set, for one), so the tiny Worker also runs as
// wrangler bundles it for a deploy: built here, then served beside the tests as the BUNDLED service.
const CONFIG = "test/workerd/wrangler.jsonc";
const WRANGLER = fileURLToPath(new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url));
// Under .wrangler/, which git ignores; rebuilt on every run.
const OUT = fileURLToPath(new URL("./.wrangler/footprint-test-bundle", import.meta.url));

function bundle(out = OUT) {
	rmSync(out, { recursive: true, force: true });
	execFileSync(process.execPath, [WRANGLER, "deploy", "--dry-run", "--outdir", out, "--config", CONFIG], {
		stdio: "pipe",
	});
	const files = readdirSync(out).filter((f) => f.endsWith(".js") || f.endsWith(".wasm"));
	return {
		modulesRoot: out,
		// The entry first; the .wasm files as the CompiledWasm modules wrangler would upload.
		modules: files
			.sort((a, b) => Number(b.endsWith(".js")) - Number(a.endsWith(".js")))
			.map((f) => ({
				type: f.endsWith(".wasm") ? ("CompiledWasm" as const) : ("ESModule" as const),
				path: join(out, f),
			})),
	};
}

export default defineConfig({
	plugins: [
		cloudflareTest(() => ({
			wrangler: { configPath: `./${CONFIG}` },
			miniflare: {
				serviceBindings: { BUNDLED: "githive-footprint-bundled" },
				workers: [
					{
						name: "githive-footprint-bundled",
						compatibilityDate: "2026-10-01",
						compatibilityFlags: ["nodejs_compat"],
						...bundle(),
					},
				],
			},
		})),
	],
	test: { include: ["test/workerd/**/*.test.ts"] },
});
