import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Durable Object classes import cloudflare:workers; tests run them in Node with a stand-in.
		alias: { "cloudflare:workers": fileURLToPath(new URL("./test/fakes/cloudflare-workers.ts", import.meta.url)) },
	},
	test: { exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**"] },
});
