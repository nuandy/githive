import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is built into web/dist and served by the Worker as static
// assets. In development, API calls go to the deployed Worker, where the real
// repos and agents live (local dev has no containers). The Worker keeps its
// blueprint name and host until githive.app is set up.
const api = process.env.GITHIVE_API ?? "https://blueprint.nuandy.workers.dev";

export default defineConfig({
	root: __dirname,
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		// /repos carries each repo's live feed too (a WebSocket at /repos/<owner>/<name>/live).
		proxy: Object.fromEntries(["/repos", "/api", "/summaries", "/live", "/me", "/auth", "/orgs"].map((p) => [p, { target: api, changeOrigin: true, ws: p === "/live" || p === "/repos" }])),
	},
});
