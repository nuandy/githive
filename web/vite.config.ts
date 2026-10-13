import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The dashboard is built into web/dist and served by the Worker as static
// assets. In development, API calls go to the deployed Worker, where the real
// repos and agents live (local dev has no containers): githive.app. Its old
// workers.dev host sits behind Cloudflare Access, whose sign-in redirect a
// proxied fetch can't follow. GITHIVE_API points elsewhere, or at the fixtures (below).
const api = process.env.GITHIVE_API ?? "https://githive.app";

const src = fileURLToPath(new URL("./src", import.meta.url));

const API_PATHS = ["/repos", "/api", "/summaries", "/live", "/me", "/auth", "/orgs", "/admin", "/demo"];

// GITHIVE_API=fixtures: no Worker at all. The API answers from the visual check's synthetic fixtures (web/visual),
// signed in as their admin (GITHIVE_AS=visitor or operator for the others), with their times moved up to now. Writes
// answer as if they worked and change nothing.
const fixtures: Plugin = {
	name: "githive-fixtures",
	configureServer(server) {
		const who = process.env.GITHIVE_AS ?? "admin";
		const started = Date.now();
		server.middlewares.use(async (req, res, next) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (!API_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return next();
			const { answer, FIXED_NOW } = await server.ssrLoadModule("/visual/fixtures.ts");
			const reply = answer(req.method ?? "GET", url, who) ?? { status: 404, body: { error: "no fixture" } };
			const shift = started - FIXED_NOW;
			const body = JSON.stringify(reply.body, (_, value) =>
				typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)
					? new Date(Date.parse(value) + shift).toISOString()
					: value,
			);
			res.statusCode = reply.status;
			res.setHeader("Content-Type", "application/json");
			res.end(body);
		});
	},
};
const useFixtures = api === "fixtures";

export default defineConfig({
	root: __dirname,
	plugins: [tailwindcss(), react(), ...(useFixtures ? [fixtures] : [])],
	resolve: { alias: { "@": src } },
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		// /repos carries each repo's live feed too (a WebSocket at /repos/<owner>/<name>/live).
		proxy: useFixtures
			? undefined
			: Object.fromEntries(
					["/repos", "/api", "/summaries", "/live", "/me", "/auth", "/orgs", "/admin"].map((p) => [
						p,
						{ target: api, changeOrigin: true, ws: p === "/live" || p === "/repos" },
					]),
				),
	},
});
