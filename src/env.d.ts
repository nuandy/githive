// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
interface Env {
	/** Bearer token required on write routes. Unset disables auth (local dev only). */
	API_TOKEN?: string;
}
