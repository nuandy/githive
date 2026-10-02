// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
interface Env {
	/** Bearer token required on write routes. Unset disables auth (local dev only). */
	API_TOKEN?: string;
	/** OpenAI key for the planner agent (gpt-6-luna). */
	OPENAI_API_KEY?: string;
}
