// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
interface Env {
	/** 32 bytes, base64: seals each person's model key before it's stored (see models/settings.ts). */
	MODEL_KEYS_SECRET?: string;
	/** GitHive's Ed25519 signing key (PKCS #8, base64): stamps records with verified identity. */
	STAMP_KEY?: string;
	/** GitHive's GitHub App ID and PKCS#8 PEM private key (see github.ts). Without them, no repo connects to GitHub. */
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	/** "off" lands every batch in the repo's Gate; otherwise batches land with trees in the Worker (tree-landing.ts). */
	TREE_LANDING?: string;
}
