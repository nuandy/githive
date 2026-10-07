// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
interface Env {
	/** OpenAI key for GitHive's builder and reviewer agents (gpt-6-luna). */
	OPENAI_API_KEY?: string;
	/** GitHive's Ed25519 signing key (PKCS #8, base64): stamps records with verified identity. */
	STAMP_KEY?: string;
}
