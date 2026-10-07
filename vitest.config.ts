import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Durable Object classes import cloudflare:workers; tests run them in Node with a stand-in.
		alias: { "cloudflare:workers": fileURLToPath(new URL("./test/fakes/cloudflare-workers.ts", import.meta.url)) },
	},
	// node:sqlite stands in for D1 in tests; Node 22 still keeps it behind a flag.
	test: { exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**"], execArgv: ["--experimental-sqlite", "--no-warnings=ExperimentalWarning"],
		// Run through Vite, so its cloudflare:workers import gets the stand-in above.
		server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
	},
});
