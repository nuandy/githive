import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is built into web/dist and served by the Worker as static
// assets. In development, API calls go to the deployed Worker, where the real
// tasks and agents live (local dev has no containers).
const api = process.env.BLUEPRINT_API ?? "https://blueprint.nuandy.workers.dev";

export default defineConfig({
	root: __dirname,
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		proxy: Object.fromEntries(["/tasks", "/repos", "/api", "/free", "/summaries", "/live"].map((p) => [p, { target: api, changeOrigin: true, ws: p === "/live" }])),
	},
});
