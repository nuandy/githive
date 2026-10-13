import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is built into web/dist and served by the Worker as static
// assets. In development, API calls go to the deployed Worker, where the real
// repos and agents live (local dev has no containers): githive.app. Its old
// workers.dev host sits behind Cloudflare Access, whose sign-in redirect a
// proxied fetch can't follow. GITHIVE_API points elsewhere.
const api = process.env.GITHIVE_API ?? "https://githive.app";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
	root: __dirname,
	plugins: [tailwindcss(), react()],
	resolve: { alias: { "@": src } },
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		// /repos carries each repo's live feed too (a WebSocket at /repos/<owner>/<name>/live).
		proxy: Object.fromEntries(
			["/repos", "/api", "/summaries", "/live", "/me", "/auth", "/orgs", "/admin"].map((p) => [
				p,
				{ target: api, changeOrigin: true, ws: p === "/live" || p === "/repos" },
			]),
		),
	},
});
