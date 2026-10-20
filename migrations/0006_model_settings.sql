-- Each person's model for GitHive's hosted agents (src/models/settings.ts). The key is sealed with AES-GCM under the
-- Worker's MODEL_KEYS_SECRET; key_ending is its last four characters, the only part ever shown again.
CREATE TABLE model_settings (
	user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	base_url TEXT,
	sealed_key TEXT NOT NULL,
	key_ending TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
